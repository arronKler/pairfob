package workspace

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// File search answers "where is that file" without walking the tree one
// directory at a time: every file of the workspace whose path contains the
// words typed, best match first. Inside a Git repository the candidates are
// what Git tracks plus what it does not ignore, so build output and
// dependencies stay out; elsewhere the tree is walked within fixed bounds.

const (
	DefaultSearchLimit  = 30
	MaxSearchLimit      = 50
	MaxSearchQueryRunes = 128

	maxSearchListBytes   = 8 << 20
	maxSearchWalkEntries = 50_000
	maxSearchMatches     = 2_000
	searchWalkTimeout    = 3 * time.Second
	searchListingAge     = 3 * time.Second
)

type SearchItem struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type SearchPage struct {
	Query string       `json:"query"`
	Items []SearchItem `json:"items"`
	// Truncated says more files matched, or the tree was too large to list in full.
	Truncated bool `json:"truncated"`
}

// searchWords lowers and splits a query. Every word has to be in the path.
func searchWords(query string) []string {
	return strings.Fields(strings.ToLower(query))
}

// searchRank orders a matching path: its name is the query, starts with it,
// contains it, or only its folders do. Lower is better; -1 does not match.
func searchRank(lowerPath string, words []string) int {
	for _, word := range words {
		if !strings.Contains(lowerPath, word) {
			return -1
		}
	}
	name := path.Base(lowerPath)
	last := words[len(words)-1]
	switch {
	case name == last:
		return 0
	case strings.HasPrefix(name, last):
		return 1
	case strings.Contains(name, last):
		return 2
	default:
		return 3
	}
}

type searchMatch struct {
	path string
	rank int
}

// trackedFiles lists the workspace's files as Git sees them, relative to the
// workspace root: tracked files, and untracked ones that are not ignored.
func trackedFiles(workspace string) ([]string, bool, error) {
	data, truncated, err := runGit(workspace, maxSearchListBytes, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".")
	if err != nil {
		return nil, false, err
	}
	records := strings.Split(string(data), "\x00")
	if truncated && len(records) > 0 {
		records = records[:len(records)-1]
	}
	return records, truncated, nil
}

// walkedFiles lists a directory that is not a repository, within fixed bounds.
func walkedFiles(root string) ([]string, bool) {
	var files []string
	deadline := time.Now().Add(searchWalkTimeout)
	seen := 0
	truncated := false
	_ = filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		seen++
		if seen > maxSearchWalkEntries || time.Now().After(deadline) {
			truncated = true
			return fs.SkipAll
		}
		name := entry.Name()
		if entry.IsDir() {
			if current != root && (name == ".git" || name == "node_modules") {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		relative, relErr := filepath.Rel(root, current)
		if relErr == nil {
			files = append(files, filepath.ToSlash(relative))
		}
		return nil
	})
	return files, truncated
}

// searchListing is the last workspace listed and what it held. A search runs
// at every pause in typing, and each would otherwise list the whole tree
// again; for a few seconds the next one reads this instead. It is dropped when
// it ages, so a daemon does not keep a large tree's names for a search that
// ended long ago.
var searchListing struct {
	sync.Mutex
	root      string
	files     []string
	truncated bool
	at        time.Time
	drop      *time.Timer
}

func rememberedFiles(root string) ([]string, bool, bool) {
	searchListing.Lock()
	defer searchListing.Unlock()
	if searchListing.root != root || time.Since(searchListing.at) > searchListingAge {
		return nil, false, false
	}
	return searchListing.files, searchListing.truncated, true
}

func rememberFiles(root string, files []string, truncated bool) {
	searchListing.Lock()
	defer searchListing.Unlock()
	if searchListing.drop != nil {
		searchListing.drop.Stop()
	}
	searchListing.root, searchListing.files, searchListing.truncated, searchListing.at = root, files, truncated, time.Now()
	searchListing.drop = time.AfterFunc(searchListingAge, func() {
		searchListing.Lock()
		defer searchListing.Unlock()
		if time.Since(searchListing.at) >= searchListingAge {
			searchListing.root, searchListing.files, searchListing.drop = "", nil, nil
		}
	})
}

// forgetSearchListing drops the listing of a workspace whose files were just
// renamed or deleted from here, so a search right after sees the new names.
func forgetSearchListing(root string) {
	searchListing.Lock()
	defer searchListing.Unlock()
	if searchListing.root != root {
		return
	}
	if searchListing.drop != nil {
		searchListing.drop.Stop()
	}
	searchListing.root, searchListing.files, searchListing.drop = "", nil, nil
}

// searchFiles lists the workspace's files: Git's view inside a repository, a
// bounded walk elsewhere.
func searchFiles(root string) ([]string, bool, error) {
	// Check before either the cache, Git, or the filesystem walk. An unavailable
	// Git view must never fall back to recursively scanning the entire home.
	if broadScanRoot(root) {
		return nil, false, ErrInvalidPath
	}
	if files, truncated, ok := rememberedFiles(root); ok {
		return files, truncated, nil
	}
	var files []string
	var truncated bool
	if _, repoErr := repositoryRoot(root); repoErr == nil {
		var err error
		if files, truncated, err = trackedFiles(root); err != nil {
			return nil, false, err
		}
	} else {
		files, truncated = walkedFiles(root)
	}
	rememberFiles(root, files, truncated)
	return files, truncated, nil
}

// Search returns the files of the workspace whose path contains every word of
// the query, best match first. An empty query matches nothing.
func (i *Inspector) Search(root, query string, limit int) (SearchPage, error) {
	root, err := canonicalRoot(root)
	if err != nil {
		return SearchPage{}, err
	}
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) > MaxSearchQueryRunes {
		return SearchPage{}, ErrInvalidPath
	}
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		limit = MaxSearchLimit
	}
	page := SearchPage{Query: query, Items: []SearchItem{}}
	words := searchWords(query)
	if len(words) == 0 {
		return page, nil
	}
	candidates, truncated, err := searchFiles(root)
	if err != nil {
		return SearchPage{}, err
	}
	page.Truncated = truncated
	// Git lists a path once per side while it is in conflict.
	seen := map[string]bool{}
	matches := make([]searchMatch, 0, 64)
	for _, candidate := range candidates {
		clean, cleanErr := cleanRelative(filepathSlash(candidate))
		if cleanErr != nil || clean == "" {
			continue
		}
		rank := searchRank(strings.ToLower(clean), words)
		if rank < 0 || seen[clean] {
			continue
		}
		seen[clean] = true
		if len(matches) == maxSearchMatches {
			page.Truncated = true
			break
		}
		matches = append(matches, searchMatch{path: clean, rank: rank})
	}
	sort.SliceStable(matches, func(a, b int) bool {
		if matches[a].rank != matches[b].rank {
			return matches[a].rank < matches[b].rank
		}
		if len(matches[a].path) != len(matches[b].path) {
			return len(matches[a].path) < len(matches[b].path)
		}
		return matches[a].path < matches[b].path
	})
	encodedSize := 0
	for _, match := range matches {
		if len(page.Items) == limit {
			page.Truncated = true
			break
		}
		// Git still lists a tracked file that was deleted from the working tree,
		// and lists links and submodules, which are not files to open.
		info, statErr := os.Lstat(filepath.Join(root, filepath.FromSlash(match.path)))
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		item := SearchItem{Path: match.path, Name: path.Base(match.path)}
		size := encodedJSONSize(item)
		if encodedSize+size > MaxResultJSONBytes {
			page.Truncated = true
			break
		}
		encodedSize += size
		page.Items = append(page.Items, item)
	}
	return page, nil
}
