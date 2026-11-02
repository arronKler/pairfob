//go:build unix

// Tests for where uploads are stored: the per-root base directory in the temp
// directory, its safety check, and its sharing between panes of one root.
package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const baseTestID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

func useTempDir(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	return tmp
}

func TestAttachmentLandsInTempDirNotPaneRoot(t *testing.T) {
	root := t.TempDir()
	tmp := useTempDir(t)
	data := []byte("png bytes")
	stage, res, err := commitUpload(t, root, baseTestID, "image/png", data)
	if err != nil || !res.Published {
		t.Fatalf("commit: %+v %v", res, err)
	}
	_ = stage
	canon, _ := filepath.EvalSymlinks(root)
	sum := sha256.Sum256([]byte(canon))
	want := filepath.Join(tmp, "pairfob-attachments", hex.EncodeToString(sum[:])[:16], baseTestID, "attachment.png")
	got, err := os.ReadFile(want)
	if err != nil || string(got) != string(data) {
		t.Fatalf("upload not at %s: %q %v", want, got, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("pane root not empty: %v %v", entries, err)
	}
}

func TestAttachmentRefusesUnsafeBase(t *testing.T) {
	cases := map[string]func(t *testing.T, base string){
		"mode 0755": func(t *testing.T, base string) {
			if err := os.MkdirAll(base, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(base, 0o755); err != nil {
				t.Fatal(err)
			}
		},
		"symlink": func(t *testing.T, base string) {
			if err := os.MkdirAll(filepath.Dir(base), 0o700); err != nil {
				t.Fatal(err)
			}
			target := t.TempDir()
			if err := os.Chmod(target, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, base); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			useTempDir(t)
			base := testBase(t, root)
			setup(t, base)
			_, err := BeginAttachment(root, baseTestID, "image/png", 3)
			if !errors.Is(err, ErrAttachBaseUnsafe) {
				t.Fatalf("begin = %v, want ErrAttachBaseUnsafe", err)
			}
			entries, _ := os.ReadDir(root)
			if len(entries) != 0 {
				t.Fatalf("pane root not empty: %v", entries)
			}
		})
	}
}

func TestAttachBaseSharedByCanonicalRoot(t *testing.T) {
	useTempDir(t)
	root := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	a, b := testBase(t, root), testBase(t, link)
	if a != b {
		t.Fatalf("same canonical root, bases differ: %s %s", a, b)
	}
	if c := testBase(t, t.TempDir()); c == a {
		t.Fatalf("different roots share base %s", a)
	}
}
