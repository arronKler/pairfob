package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	dirIndexDepth       = 6
	dirIndexMaxDirs     = 10_000
	dirIndexBudget      = 3 * time.Second
	dirIndexListTimeout = 2 * time.Second
	dirIndexTTL         = 15 * time.Minute
	dirIndexMaxWorkers  = 8
	// The reply is one encrypted RPC result: aead.MaxPlaintext caps the whole
	// envelope at 262,116 bytes. The index stops short of that so the RPC
	// wrapper around it fits too.
	dirIndexReplyBudget = 256_000
)

type dirIndexRow struct {
	Path string `json:"p"`
	Repo bool   `json:"r,omitempty"`
}

type dirIndexRoot struct {
	Path string        `json:"path"`
	Repo bool          `json:"repo"`
	Dirs []dirIndexRow `json:"dirs"`
}

type dirIndexSnapshot struct {
	Version   string         `json:"version"`
	Roots     []dirIndexRoot `json:"roots"`
	Truncated bool           `json:"truncated"`
	BuiltAt   time.Time      `json:"-"`
}

// dirIndexer keeps one in-memory directory index. The zero value is ready:
// the first request builds it, later requests read it, and a request past the
// TTL gets the stale copy while one background build replaces it.
type dirIndexer struct {
	mu       sync.Mutex
	snap     *dirIndexSnapshot
	building chan struct{}
	poisoned map[string]struct{}

	// Unset in production. Tests lower a bound or replace the filesystem.
	depth       int
	maxDirs     int
	budget      time.Duration
	listTimeout time.Duration
	workers     int
	ttl         time.Duration
	now         func() time.Time
	listDir     func(string) ([]os.DirEntry, error)
}

type dirIndexBounds struct {
	depth       int
	maxDirs     int
	budget      time.Duration
	listTimeout time.Duration
	ttl         time.Duration
	workers     int
}

func (d *dirIndexer) bounds() dirIndexBounds {
	b := dirIndexBounds{
		depth: dirIndexDepth, maxDirs: dirIndexMaxDirs, budget: dirIndexBudget,
		listTimeout: dirIndexListTimeout, ttl: dirIndexTTL,
		workers: min(dirIndexMaxWorkers, runtime.GOMAXPROCS(0)),
	}
	if d.depth > 0 {
		b.depth = d.depth
	}
	if d.maxDirs > 0 {
		b.maxDirs = d.maxDirs
	}
	if d.budget > 0 {
		b.budget = d.budget
	}
	if d.listTimeout > 0 {
		b.listTimeout = d.listTimeout
	}
	if d.ttl > 0 {
		b.ttl = d.ttl
	}
	if d.workers > 0 {
		b.workers = d.workers
	}
	return b
}

func (d *dirIndexer) clock() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

func (d *dirIndexer) listing() func(string) ([]os.DirEntry, error) {
	if d.listDir != nil {
		return d.listDir
	}
	return os.ReadDir
}

// snapshot answers one DirIndex request. unchanged reports that version still
// names the current index. A stale index is returned at once; the rebuild runs
// behind it so no keystroke or page open waits for the filesystem.
func (d *dirIndexer) snapshot(roots []string, version string) (dirIndexSnapshot, bool) {
	bounds := d.bounds()
	now := d.clock()
	d.mu.Lock()
	current := d.snap
	if current != nil && now.Sub(current.BuiltAt) <= bounds.ttl {
		out := *current
		d.mu.Unlock()
		return out, out.Version == version
	}
	if current != nil {
		if d.building == nil {
			d.startLocked(roots)
		}
		out := *current
		d.mu.Unlock()
		return out, out.Version == version
	}
	wait := d.building
	if wait == nil {
		wait = d.startLocked(roots)
	}
	d.mu.Unlock()
	<-wait
	d.mu.Lock()
	out := *d.snap
	d.mu.Unlock()
	return out, out.Version == version
}

// startLocked starts the only build allowed at a time. The caller holds d.mu.
func (d *dirIndexer) startLocked(roots []string) chan struct{} {
	done := make(chan struct{})
	d.building = done
	copied := append([]string(nil), roots...)
	go func() {
		snapshot := d.build(copied, d.bounds())
		d.mu.Lock()
		d.snap = &snapshot
		d.building = nil
		d.mu.Unlock()
		close(done)
	}()
	return done
}

type dirIndexJob struct {
	root  int
	rel   string
	abs   string
	depth int
}

type dirIndexListed struct {
	job     dirIndexJob
	entries []os.DirEntry
	err     error
}

var errDirIndexTimeout = errors.New("directory listing timed out")

// build walks the roots breadth first, one level at a time, so a spent budget
// drops deep directories instead of a whole branch. Every included directory
// is listed once: its entries say whether it holds .git and which directories
// come next.
func (d *dirIndexer) build(roots []string, bounds dirIndexBounds) dirIndexSnapshot {
	started := d.clock()
	deadline := started.Add(bounds.budget)
	snapshot := dirIndexSnapshot{BuiltAt: started, Roots: make([]dirIndexRoot, len(roots))}
	rows := make([]map[string]dirIndexRow, len(roots))
	for index, root := range roots {
		snapshot.Roots[index] = dirIndexRoot{Path: root, Dirs: []dirIndexRow{}}
		rows[index] = map[string]dirIndexRow{}
	}
	total := 0
	truncated := false
	level := make([]dirIndexJob, len(roots))
	for index, root := range roots {
		level[index] = dirIndexJob{root: index, abs: root}
	}
	for len(level) > 0 {
		if !d.clock().Before(deadline) {
			truncated = true
			break
		}
		live := make([]dirIndexJob, 0, len(level))
		for _, job := range level {
			if !d.isPoisoned(job.abs) {
				live = append(live, job)
			}
		}
		timeout := bounds.listTimeout
		budgetLimited := false
		if remaining := deadline.Sub(d.clock()); remaining < timeout {
			timeout = remaining
			budgetLimited = true
		}
		if timeout <= 0 {
			truncated = true
			break
		}
		next := make([]dirIndexJob, 0, len(live))
		for _, listed := range d.list(live, timeout, bounds.workers) {
			if listed.err != nil {
				if errors.Is(listed.err, errDirIndexTimeout) {
					if budgetLimited {
						truncated = true
					} else {
						d.poison(listed.job.abs)
					}
				}
				continue
			}
			repo := hasGitEntry(listed.entries)
			if listed.job.depth == 0 {
				snapshot.Roots[listed.job.root].Repo = repo
			} else {
				row := rows[listed.job.root][listed.job.rel]
				row.Repo = repo
				rows[listed.job.root][listed.job.rel] = row
			}
			if listed.job.depth >= bounds.depth {
				continue
			}
			for _, name := range dirIndexChildren(listed.entries) {
				if total >= bounds.maxDirs {
					truncated = true
					break
				}
				rel := path.Join(listed.job.rel, name)
				if _, seen := rows[listed.job.root][rel]; seen {
					continue
				}
				rows[listed.job.root][rel] = dirIndexRow{Path: rel}
				total++
				next = append(next, dirIndexJob{root: listed.job.root, rel: rel, abs: filepath.Join(listed.job.abs, name), depth: listed.job.depth + 1})
			}
			if total >= bounds.maxDirs {
				truncated = true
			}
		}
		level = next
	}
	for index := range snapshot.Roots {
		dirs := make([]dirIndexRow, 0, len(rows[index]))
		for _, row := range rows[index] {
			dirs = append(dirs, row)
		}
		sort.Slice(dirs, func(left, right int) bool { return dirs[left].Path < dirs[right].Path })
		snapshot.Roots[index].Dirs = dirs
	}
	sort.Slice(snapshot.Roots, func(left, right int) bool { return snapshot.Roots[left].Path < snapshot.Roots[right].Path })
	snapshot.Roots, snapshot.Truncated = fitDirIndex(snapshot.Roots, truncated)
	snapshot.Version = dirIndexVersion(snapshot.Roots)
	return snapshot
}

// fitDirIndex keeps the reply inside one encrypted frame. The deepest rows go
// first, so a large tree loses its ends rather than the shallow directories a
// reader searches by name. Among rows of one depth the longest path goes first,
// because it costs the most bytes: dropping expensive rows keeps more of them.
func fitDirIndex(roots []dirIndexRoot, truncated bool) ([]dirIndexRoot, bool) {
	if dirIndexReplySize(roots, truncated) <= dirIndexReplyBudget {
		return roots, truncated
	}
	drops := make([]dirIndexDrop, 0, 1024)
	for rootIndex, root := range roots {
		for rowIndex, row := range root.Dirs {
			drops = append(drops, dirIndexDrop{
				root: rootIndex, row: rowIndex, depth: strings.Count(row.Path, "/") + 1, cost: len(row.Path),
			})
		}
	}
	if len(drops) == 0 {
		return roots, true
	}
	sort.Slice(drops, func(left, right int) bool {
		a, b := drops[left], drops[right]
		if a.depth != b.depth {
			return a.depth > b.depth
		}
		if a.cost != b.cost {
			return a.cost > b.cost
		}
		if a.root != b.root {
			return a.root > b.root
		}
		return a.row > b.row
	})
	// The reply shrinks with every dropped row, so the smallest count that fits
	// can be found by bisection.
	low, high := 1, len(drops)
	for low < high {
		middle := low + (high-low)/2
		if dirIndexReplySize(dropDirIndexRows(roots, drops[:middle]), true) <= dirIndexReplyBudget {
			high = middle
		} else {
			low = middle + 1
		}
	}
	return dropDirIndexRows(roots, drops[:low]), true
}

type dirIndexDrop struct {
	root  int
	row   int
	depth int
	cost  int
}

func dropDirIndexRows(roots []dirIndexRoot, drops []dirIndexDrop) []dirIndexRoot {
	gone := make(map[int]map[int]struct{}, len(drops))
	for _, item := range drops {
		rows := gone[item.root]
		if rows == nil {
			rows = map[int]struct{}{}
			gone[item.root] = rows
		}
		rows[item.row] = struct{}{}
	}
	kept := make([]dirIndexRoot, len(roots))
	for rootIndex, root := range roots {
		dirs := make([]dirIndexRow, 0, len(root.Dirs))
		for rowIndex, row := range root.Dirs {
			if _, dropped := gone[rootIndex][rowIndex]; dropped {
				continue
			}
			dirs = append(dirs, row)
		}
		kept[rootIndex] = dirIndexRoot{Path: root.Path, Repo: root.Repo, Dirs: dirs}
	}
	return kept
}

// A version is always sixteen hex characters, so a placeholder measures the
// final reply exactly.
func dirIndexReplySize(roots []dirIndexRoot, truncated bool) int {
	body, err := json.Marshal(dirIndexReply{Version: "0000000000000000", Roots: roots, Truncated: truncated})
	if err != nil {
		return dirIndexReplyBudget + 1
	}
	return len(body)
}

// list runs the level's listings on a bounded set of workers. Each result
// lands in its own slot, so no listing touches shared state.
func (d *dirIndexer) list(jobs []dirIndexJob, timeout time.Duration, workers int) []dirIndexListed {
	if len(jobs) == 0 {
		return nil
	}
	workers = max(1, min(workers, len(jobs)))
	results := make([]dirIndexListed, len(jobs))
	work := make(chan int)
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range work {
				job := jobs[index]
				entries, err := d.readDir(job.abs, timeout)
				results[index] = dirIndexListed{job: job, entries: entries, err: err}
			}
		}()
	}
	for index := range jobs {
		work <- index
	}
	close(work)
	group.Wait()
	return results
}

// readDir bounds one listing. The read cannot be cancelled, because the block
// is in the kernel: on this platform FileProvider directories never return.
// The goroutine reports on its own buffered channel and is left to finish.
func (d *dirIndexer) readDir(dir string, timeout time.Duration) ([]os.DirEntry, error) {
	type listed struct {
		entries []os.DirEntry
		err     error
	}
	done := make(chan listed, 1)
	listing := d.listing()
	go func() {
		entries, err := listing(dir)
		done <- listed{entries: entries, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-done:
		return result.entries, result.err
	case <-timer.C:
		return nil, errDirIndexTimeout
	}
}

func (d *dirIndexer) isPoisoned(dir string) bool {
	_, poisoned := d.poisoned[dir]
	return poisoned
}

func (d *dirIndexer) poison(dir string) {
	if d.poisoned == nil {
		d.poisoned = map[string]struct{}{}
	}
	d.poisoned[dir] = struct{}{}
}

func hasGitEntry(entries []os.DirEntry) bool {
	for _, entry := range entries {
		if entry.Name() == ".git" {
			return true
		}
	}
	return false
}

// dirIndexChildren keeps directories only: a symlink never becomes a row, and
// a skipped name is never entered. Several of these names are large generated
// trees; a few never return from a read at all, and this list is what keeps a
// build from hanging on them. .git is caught by the dot rule.
var dirIndexSkipped = map[string]struct{}{
	"node_modules": {}, "dist": {}, "target": {}, "build": {}, ".next": {}, ".venv": {}, "venv": {},
	"vendor": {}, "__pycache__": {}, ".idea": {}, ".vscode": {}, ".gradle": {}, ".terraform": {},
	".cache": {}, ".npm": {}, ".cargo": {}, ".rustup": {}, ".local": {}, "Library": {},
	"Applications": {}, "Desktop": {}, "Documents": {}, "Downloads": {}, "Movies": {}, "Music": {},
	"Pictures": {}, "Public": {}, ".Trash": {},
}

func dirIndexSkip(name string) bool {
	if name != ".config" && strings.HasPrefix(name, ".") {
		return true
	}
	_, skipped := dirIndexSkipped[name]
	return skipped
}

func dirIndexChildren(entries []os.DirEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || dirIndexSkip(entry.Name()) {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func dirIndexVersion(roots []dirIndexRoot) string {
	hash := fnv.New64a()
	for _, root := range roots {
		_, _ = fmt.Fprintf(hash, "r\x00%s\x00%t\n", root.Path, root.Repo)
		for _, row := range root.Dirs {
			_, _ = fmt.Fprintf(hash, "d\x00%s\x00%t\n", row.Path, row.Repo)
		}
	}
	return fmt.Sprintf("%016x", hash.Sum64())
}

// dirIndexRoots is the set the index may name: the live workspace and pane
// directories first, then the configured allowlist. A root inside another root
// is dropped so no directory is listed twice.
func (e *Engine) dirIndexRoots(session *string) []string {
	roots := make([]string, 0, 8)
	if snapshot, err := e.workspaceSnapshot(session); err == nil {
		for _, workspace := range snapshot.Workspaces {
			roots = appendDirIndexRoot(roots, workspace.Cwd)
		}
		for _, pane := range snapshot.Panes {
			roots = appendDirIndexRoot(roots, pane.Cwd)
		}
	}
	if configured, err := configuredAllowedRoots(); err == nil {
		roots = append(roots, configured...)
	}
	return foldDirIndexRoots(roots)
}

func appendDirIndexRoot(roots []string, candidate string) []string {
	if candidate == "" || !filepath.IsAbs(candidate) {
		return roots
	}
	root, err := resolvedPath(candidate)
	if err != nil {
		return roots
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return roots
	}
	return append(roots, root)
}

func foldDirIndexRoots(roots []string) []string {
	folded := make([]string, 0, len(roots))
	for _, root := range roots {
		covered := false
		for _, existing := range folded {
			if withinPath(existing, root) {
				covered = true
				break
			}
		}
		if covered {
			continue
		}
		kept := folded[:0]
		for _, existing := range folded {
			if !withinPath(root, existing) {
				kept = append(kept, existing)
			}
		}
		folded = append(kept, root)
	}
	return folded
}
