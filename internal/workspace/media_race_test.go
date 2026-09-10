package workspace

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestMediaFileConcurrentCloseAndRead(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "x.bin"), make([]byte, 65536), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		file, err := NewInspector().OpenMedia(root, "x.bin")
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _, _ = file.ReadChunk(0, 1)
		}()
		go func() {
			defer wg.Done()
			_ = file.Close()
		}()
		wg.Wait()
	}
}
