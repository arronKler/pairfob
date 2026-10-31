package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/runtime"
)

func dirIndexRootResult(t *testing.T, result map[string]any, root string) map[string]any {
	t.Helper()
	canonical, err := resolvedPath(root)
	if err != nil {
		t.Fatal(err)
	}
	roots, ok := result["roots"].([]any)
	if !ok {
		t.Fatalf("roots is not an array: %v", result)
	}
	for _, item := range roots {
		entry, ok := item.(map[string]any)
		if ok && entry["path"] == canonical {
			return entry
		}
	}
	t.Fatalf("root %s missing from %v", canonical, roots)
	return nil
}

func dirIndexRowsOf(t *testing.T, root map[string]any) (map[string]bool, []string) {
	t.Helper()
	dirs, ok := root["dirs"].([]any)
	if !ok {
		t.Fatalf("dirs is not an array: %v", root)
	}
	repo := map[string]bool{}
	paths := make([]string, 0, len(dirs))
	for _, item := range dirs {
		row, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("dirs row is not an object: %v", item)
		}
		path, _ := row["p"].(string)
		marked, _ := row["r"].(bool)
		repo[path] = marked
		paths = append(paths, path)
	}
	return repo, paths
}

func TestDirIndexFitsEncryptedReply(t *testing.T) {
	small := []dirIndexRoot{{Path: "/srv", Dirs: []dirIndexRow{{Path: "app"}}}}
	if kept, truncated := fitDirIndex(small, false); truncated || len(kept[0].Dirs) != 1 {
		t.Fatalf("a small index was changed: %v, truncated %v", kept, truncated)
	}
	rows := make([]dirIndexRow, 4_000)
	for index := range rows {
		rows[index] = dirIndexRow{Path: fmt.Sprintf("dir-%04d-%s", index, strings.Repeat("x", 64))}
	}
	if size := dirIndexReplySize([]dirIndexRoot{{Path: "/home/me", Dirs: rows}}, false); size <= dirIndexReplyBudget {
		t.Fatalf("fixture reply is %d bytes, under the %d budget", size, dirIndexReplyBudget)
	}
	trimmed, truncated := fitDirIndex([]dirIndexRoot{{Path: "/home/me", Dirs: rows}}, false)
	if !truncated {
		t.Fatal("a trimmed index was not marked truncated")
	}
	if size := dirIndexReplySize(trimmed, truncated); size > dirIndexReplyBudget {
		t.Fatalf("trimmed reply is %d bytes, over the %d budget", size, dirIndexReplyBudget)
	}
	if kept := len(trimmed[0].Dirs); kept == 0 || kept >= len(rows) {
		t.Fatalf("trimmed to %d of %d rows", kept, len(rows))
	}
	if trimmed[0].Dirs[0] != rows[0] {
		t.Fatalf("the first row changed to %v", trimmed[0].Dirs[0])
	}
	wrapped, err := json.Marshal(map[string]any{
		"v": 1, "id": strings.Repeat("i", 128), "ok": true,
		"result": dirIndexReply{Version: "0000000000000000", Roots: trimmed, Truncated: truncated},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(wrapped) > aead.MaxPlaintext {
		t.Fatalf("wrapped reply is %d bytes, over the %d plaintext limit", len(wrapped), aead.MaxPlaintext)
	}
}

func TestDirIndexListsAllowedTree(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", root)
	for _, dir := range []string{"alpha/.git", "alpha/sub/deep", "node_modules/pkg", ".hidden/x", ".config/gh", "beta"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	_, client := runtimeRPCClient(t, runtime.NewFake())
	raw, err := client.RPC("DirIndex", map[string]any{"version": ""})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	if version, _ := result["version"].(string); !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(version) {
		t.Fatalf("bad version: %v", result["version"])
	}
	if result["truncated"] != false {
		t.Fatalf("unexpected truncation: %v", result)
	}
	indexed := dirIndexRootResult(t, result, root)
	if indexed["repo"] != false {
		t.Fatalf("root marked as a repository: %v", indexed)
	}
	repo, paths := dirIndexRowsOf(t, indexed)
	want := []string{".config", ".config/gh", "alpha", "alpha/sub", "alpha/sub/deep", "beta"}
	if !sort.StringsAreSorted(paths) || len(paths) != len(want) {
		t.Fatalf("rows = %q, want %q", paths, want)
	}
	for index, path := range want {
		if paths[index] != path {
			t.Fatalf("rows = %q, want %q", paths, want)
		}
	}
	if !repo["alpha"] {
		t.Fatal("alpha holds .git but was not marked as a repository")
	}
	for _, skipped := range []string{"node_modules", "node_modules/pkg", ".hidden", ".hidden/x", "alpha/.git"} {
		if _, ok := repo[skipped]; ok {
			t.Fatalf("%s was indexed", skipped)
		}
	}
}

func TestDirIndexStopsAtSixLevels(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", root)
	deep := filepath.Join(root, "d1", "d2", "d3", "d4", "d5", "d6", "d7")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, runtime.NewFake())
	raw, err := client.RPC("DirIndex", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	indexed := dirIndexRootResult(t, decodeResult(t, raw), root)
	_, paths := dirIndexRowsOf(t, indexed)
	deepest, deepestParent := "d1/d2/d3/d4/d5/d6", "d1/d2/d3/d4/d5"
	found := map[string]bool{}
	for _, path := range paths {
		found[path] = true
	}
	if !found[deepest] || !found[deepestParent] {
		t.Fatalf("six levels were not indexed: %q", paths)
	}
	if found["d1/d2/d3/d4/d5/d6/d7"] {
		t.Fatalf("a seventh level was indexed: %q", paths)
	}
}

func TestDirIndexCapsRowsAndTruncates(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", root)
	for _, dir := range []string{"one", "two", "three", "four", "five"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	engine, client := runtimeRPCClient(t, runtime.NewFake())
	engine.dirs.maxDirs = 3
	raw, err := client.RPC("DirIndex", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	_, paths := dirIndexRowsOf(t, dirIndexRootResult(t, result, root))
	if len(paths) != 3 || !sort.StringsAreSorted(paths) {
		t.Fatalf("rows = %q, want three sorted rows", paths)
	}
	if result["truncated"] != true {
		t.Fatalf("cap did not mark the index truncated: %v", result)
	}
}

func TestDirIndexRepliesUnchangedForCurrentVersion(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", root)
	_, client := runtimeRPCClient(t, runtime.NewFake())
	firstRaw, err := client.RPC("DirIndex", map[string]any{"version": ""})
	if err != nil {
		t.Fatal(err)
	}
	version := decodeResult(t, firstRaw)["version"].(string)
	unchangedRaw, err := client.RPC("DirIndex", map[string]any{"version": version})
	if err != nil {
		t.Fatal(err)
	}
	unchanged := decodeResult(t, unchangedRaw)
	if len(unchanged) != 1 || unchanged["unchanged"] != true {
		t.Fatalf("expected the unchanged reply, got %s", unchangedRaw)
	}
	staleRaw, err := client.RPC("DirIndex", map[string]any{"version": "0000000000000000"})
	if err != nil {
		t.Fatal(err)
	}
	if decodeResult(t, staleRaw)["version"] != version {
		t.Fatalf("a changed version rebuilt a different index: %s", staleRaw)
	}
}

func TestDirIndexVersionChangesWithTree(t *testing.T) {
	root := t.TempDir()
	indexer := &dirIndexer{}
	first := indexer.build([]string{root}, indexer.bounds())
	if err := os.Mkdir(filepath.Join(root, "newdir"), 0o700); err != nil {
		t.Fatal(err)
	}
	second := indexer.build([]string{root}, indexer.bounds())
	if first.Version == second.Version {
		t.Fatalf("adding a directory kept version %s", first.Version)
	}
	found := false
	for _, row := range second.Roots[0].Dirs {
		if row.Path == "newdir" {
			found = true
		}
	}
	if !found {
		t.Fatal("the added directory is missing from the rebuilt index")
	}
}

func TestDirIndexSkipsPoisonedPath(t *testing.T) {
	root := t.TempDir()
	slow := filepath.Join(root, "slow")
	if err := os.MkdirAll(slow, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "fast"), 0o700); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	calls := map[string]int{}
	indexer := &dirIndexer{
		listTimeout: 10 * time.Millisecond,
		listDir: func(dir string) ([]os.DirEntry, error) {
			mu.Lock()
			calls[dir]++
			mu.Unlock()
			if dir == slow {
				time.Sleep(50 * time.Millisecond)
				return nil, nil
			}
			return os.ReadDir(dir)
		},
	}
	first := indexer.build([]string{root}, indexer.bounds())
	if len(first.Roots[0].Dirs) != 2 {
		t.Fatalf("first build rows = %v", first.Roots[0].Dirs)
	}
	if err := os.Mkdir(filepath.Join(slow, "late"), 0o700); err != nil {
		t.Fatal(err)
	}
	second := indexer.build([]string{root}, indexer.bounds())
	for _, row := range second.Roots[0].Dirs {
		if row.Path == "slow/late" {
			t.Fatal("a timed-out directory was entered on the next build")
		}
	}
	mu.Lock()
	slowCalls := calls[slow]
	mu.Unlock()
	if slowCalls != 1 {
		t.Fatalf("the poisoned path was listed %d times, want 1", slowCalls)
	}
}
