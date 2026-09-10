package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color/palette"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func writePNG(t *testing.T, path string, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSniffRecognizesImagesAudioVideoAndSVG(t *testing.T) {
	pngBytes := writePNG(t, filepath.Join(t.TempDir(), "x.png"), 3, 5)
	kind, mime, w, h := sniffMedia(pngBytes, int64(len(pngBytes)))
	if kind != MediaImage || mime != "image/png" || w != 3 || h != 5 {
		t.Fatalf("png sniff kind=%s mime=%s %dx%d", kind, mime, w, h)
	}
	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, image.NewRGBA(image.Rect(0, 0, 2, 4)), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	kind, mime, w, h = sniffMedia(jpegBuf.Bytes(), int64(jpegBuf.Len()))
	if kind != MediaImage || mime != "image/jpeg" || w != 2 || h != 4 {
		t.Fatalf("jpeg sniff kind=%s mime=%s %dx%d", kind, mime, w, h)
	}
	var gifBuf bytes.Buffer
	if err := gif.Encode(&gifBuf, image.NewPaletted(image.Rect(0, 0, 6, 7), palette.Plan9), nil); err != nil {
		t.Fatal(err)
	}
	kind, mime, w, h = sniffMedia(gifBuf.Bytes(), int64(gifBuf.Len()))
	if kind != MediaImage || mime != "image/gif" || w != 6 || h != 7 {
		t.Fatalf("gif sniff kind=%s mime=%s %dx%d", kind, mime, w, h)
	}
	webp := []byte("RIFF\x1a\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
	webp[24], webp[27] = 9, 11
	kind, mime, w, h = sniffMedia(webp, int64(len(webp)))
	if kind != MediaImage || mime != "image/webp" || w != 10 || h != 12 {
		t.Fatalf("webp sniff kind=%s mime=%s %dx%d", kind, mime, w, h)
	}
	svg := []byte("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")
	kind, mime, _, _ = sniffMedia(svg, int64(len(svg)))
	if kind != MediaDownload || mime != "image/svg+xml" {
		t.Fatalf("svg sniff kind=%s mime=%s", kind, mime)
	}
	mp4 := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}
	kind, mime, _, _ = sniffMedia(mp4, 2048)
	if kind != MediaVideo || mime != "video/mp4" {
		t.Fatalf("mp4 sniff kind=%s mime=%s", kind, mime)
	}
	m4a := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}
	kind, mime, _, _ = sniffMedia(m4a, 2048)
	if kind != MediaAudio || mime != "audio/mp4" {
		t.Fatalf("m4a sniff kind=%s mime=%s", kind, mime)
	}
}

func TestOpenMediaReadsAuthorizedPNGAndHashesWholeFile(t *testing.T) {
	root := t.TempDir()
	payload := writePNG(t, filepath.Join(root, "cat.png"), 8, 8)
	opened, err := NewInspector().OpenMedia(root, "cat.png")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	sum := sha256.Sum256(payload)
	info := opened.Info()
	if info.Kind != MediaImage || info.MIME != "image/png" || info.Size != int64(len(payload)) || info.SHA256 != hex.EncodeToString(sum[:]) || info.Width != 8 {
		t.Fatalf("info=%+v", info)
	}
	chunk, eof, err := opened.ReadChunk(0, 16)
	if err != nil || eof || !bytes.Equal(chunk, payload[:16]) {
		t.Fatalf("chunk=%x eof=%v err=%v", chunk, eof, err)
	}
	rest, eof, err := opened.ReadChunk(16, MediaChunkBytes)
	if err != nil || !eof || !bytes.Equal(append(chunk, rest...), payload) {
		t.Fatalf("rest eof=%v err=%v", eof, err)
	}
}

func TestOpenMediaRejectsTraversalSymlinkAndNonRegular(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.bin")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ok.bin"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "ok.bin"), filepath.Join(root, "inside-link")); err != nil {
		t.Fatal(err)
	}
	inspector := NewInspector()
	if _, err := inspector.OpenMedia(root, "../secret.bin"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("traversal err=%v", err)
	}
	if _, err := inspector.OpenMedia(root, "escape"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("outside symlink err=%v", err)
	}
	if _, err := inspector.OpenMedia(root, "inside-link"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("leaf symlink err=%v", err)
	}
	if _, err := inspector.OpenMedia(root, "dir"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("directory err=%v", err)
	}
}

func TestOpenMediaEnforcesCapsAndPixelBounds(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "huge.bin"), make([]byte, MaxMediaBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewInspector().OpenMedia(root, "huge.bin"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize download err=%v", err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	payload := buf.Bytes()
	copy(payload[16:20], []byte{0, 0, 0x20, 0x01}) // 8193 width in IHDR
	if err := os.WriteFile(filepath.Join(root, "wide.png"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewInspector().OpenMedia(root, "wide.png"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("wide png err=%v", err)
	}
	jpegPrefix := append([]byte{0xff, 0xd8, 0xff, 0xe0}, make([]byte, 64)...)
	if err := os.WriteFile(filepath.Join(root, "nosof.jpg"), jpegPrefix, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewInspector().OpenMedia(root, "nosof.jpg"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("jpeg without dimensions err=%v", err)
	}
}

func TestReadChunkBoundsAndEOF(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.bin"), []byte("abcd"), 0o644); err != nil {
		t.Fatal(err)
	}
	opened, err := NewInspector().OpenMedia(root, "a.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if _, _, err := opened.ReadChunk(-1, 1); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("neg offset err=%v", err)
	}
	if _, _, err := opened.ReadChunk(0, 0); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("zero length err=%v", err)
	}
	if _, _, err := opened.ReadChunk(0, MediaChunkBytes+1); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("long chunk err=%v", err)
	}
	if _, _, err := opened.ReadChunk(5, 1); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("past end err=%v", err)
	}
	empty, eof, err := opened.ReadChunk(4, 1)
	if err != nil || !eof || len(empty) != 0 {
		t.Fatalf("eof-at-size empty=%q eof=%v err=%v", empty, eof, err)
	}
}
