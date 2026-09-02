package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFilesStayInsideRootAndPageDirectoriesFirst(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("hello 世界\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("secret=no\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	inspector := NewInspector()
	page, err := inspector.List(root, "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 2 || page.Entries[0].Name != "src" || page.Entries[0].Kind != "directory" || page.NextCursor == nil {
		t.Fatalf("page=%+v", page)
	}
	for _, entry := range page.Entries {
		if entry.Name == ".git" {
			t.Fatal(".git must stay hidden")
		}
	}
	next, err := inspector.List(root, "", *page.NextCursor, 20)
	if err != nil || len(next.Entries) != 1 || next.Entries[0].Name != "README.md" {
		t.Fatalf("next=%+v err=%v", next, err)
	}
	view, err := inspector.Read(root, "README.md")
	if err != nil || view.Kind != "text" || view.Content != "hello 世界\n" || view.Truncated {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	if _, err := inspector.List(root, "../", "", 20); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("traversal err=%v", err)
	}
}

func TestFilePreviewBoundsBinaryAndSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewInspector().Read(root, "escape"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("symlink escape err=%v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "binary"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	binary, err := NewInspector().Read(root, "binary")
	if err != nil || binary.Kind != "binary" || binary.Content != "" {
		t.Fatalf("binary=%+v err=%v", binary, err)
	}
	largeText := strings.Repeat("a", MaxPreviewBytes+10)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(largeText), 0o644); err != nil {
		t.Fatal(err)
	}
	large, err := NewInspector().Read(root, "large.txt")
	if err != nil || !large.Truncated || len(large.Content) != MaxPreviewBytes {
		t.Fatalf("large size=%d truncated=%v err=%v", len(large.Content), large.Truncated, err)
	}
	largeBinary := append([]byte(strings.Repeat("a", MaxPreviewBytes/2)), 0xff)
	largeBinary = append(largeBinary, []byte(strings.Repeat("b", MaxPreviewBytes))...)
	if err := os.WriteFile(filepath.Join(root, "large.bin"), largeBinary, 0o644); err != nil {
		t.Fatal(err)
	}
	binary, err = NewInspector().Read(root, "large.bin")
	if err != nil || binary.Kind != "binary" || binary.Content != "" {
		t.Fatalf("large binary=%+v err=%v", binary, err)
	}
}

func TestInspectorRejectsControlCharacters(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "line\nbreak.txt"), []byte("hidden"), 0o644); err != nil {
		t.Fatal(err)
	}
	page, err := NewInspector().List(root, "", "", 20)
	if err != nil || !page.Truncated || len(page.Entries) != 0 {
		t.Fatalf("control-character listing=%+v err=%v", page, err)
	}
	if _, err := NewInspector().Read(root, "line\nbreak.txt"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("control-character path err=%v", err)
	}
}

func TestFilePreviewStaysInsideEncryptedResponseBudget(t *testing.T) {
	root := t.TempDir()
	content := strings.Repeat("\t", MaxPreviewBytes)
	if err := os.WriteFile(filepath.Join(root, "escaped.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	view, err := NewInspector().Read(root, "escaped.txt")
	if err != nil || !view.Truncated || view.Kind != "text" {
		t.Fatalf("kind=%s content_bytes=%d truncated=%v err=%v", view.Kind, len(view.Content), view.Truncated, err)
	}
	encoded, err := json.Marshal(view)
	if err != nil || len(encoded) >= 230*1024 {
		t.Fatalf("encoded preview bytes=%d err=%v", len(encoded), err)
	}
}
