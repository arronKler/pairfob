package daemon

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/phone"
	"pairfob/internal/workspace"
)

func readAllMedia(t *testing.T, client *phone.Client, handle string, size int64) []byte {
	t.Helper()
	out := make([]byte, 0, size)
	for offset := int64(0); ; {
		raw, err := client.RPCTimeout("WorkspaceMediaRead", map[string]any{
			"handle": handle, "offset": offset, "length": workspace.MediaChunkBytes,
		}, 30*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		chunk := decodeResult(t, raw)
		decoded, err := base64.StdEncoding.DecodeString(chunk["bytes"].(string))
		if err != nil {
			t.Fatal(err)
		}
		if int64(chunk["offset"].(float64)) != offset || int(chunk["length"].(float64)) != len(decoded) {
			t.Fatalf("chunk meta=%v", chunk)
		}
		if base64.StdEncoding.EncodeToString(decoded) != chunk["bytes"].(string) {
			t.Fatal("base64 is not canonical")
		}
		out = append(out, decoded...)
		offset += int64(len(decoded))
		if chunk["eof"] == true {
			break
		}
	}
	if int64(len(out)) != size {
		t.Fatalf("read %d want %d", len(out), size)
	}
	return out
}

func TestWorkspaceMediaEncryptedRPCBoundarySizes(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	png := tinyPNG()
	nearImage := make([]byte, (10<<20)-64)
	copy(nearImage, png)
	cases := []struct {
		name    string
		file    string
		payload []byte
		kind    string
	}{
		{"exactly-256KiB", "a.bin", make([]byte, 256<<10), "download"},
		{"256KiB-plus-1", "b.bin", make([]byte, 256<<10+1), "download"},
		{"1MiB", "c.bin", make([]byte, 1<<20), "download"},
		{"near-10MiB-image", "photo.png", nearImage, "image"},
		{"32MiB-download", "full.bin", make([]byte, 32<<20), "download"},
	}
	for _, tc := range cases {
		if err := os.WriteFile(filepath.Join(root, tc.file), tc.payload, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, client := runtimeRPCClient(t, fake)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opened := openMedia(t, client, tc.file)
			if opened["kind"] != tc.kind || opened["size"] != float64(len(tc.payload)) {
				t.Fatalf("open=%v", opened)
			}
			sum := sha256.Sum256(tc.payload)
			if opened["sha256"] != hex.EncodeToString(sum[:]) {
				t.Fatalf("open digest=%v want %s", opened["sha256"], hex.EncodeToString(sum[:]))
			}
			handle := opened["handle"].(string)
			got := readAllMedia(t, client, handle, int64(len(tc.payload)))
			if sha256.Sum256(got) != sum {
				t.Fatal("transferred digest mismatch")
			}
			if _, err := client.RPC("WorkspaceMediaClose", map[string]any{"handle": handle}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
