package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"sync"
)

var (
	mediaReadMu       sync.Mutex
	mediaReadObserver func(int)
)

// SetMediaReadObserver reports bytes actually copied from the file after
// admission. Tests use it to prove rejected Opens do not hash first.
func SetMediaReadObserver(fn func(int)) func() {
	mediaReadMu.Lock()
	prev := mediaReadObserver
	mediaReadObserver = fn
	mediaReadMu.Unlock()
	return func() {
		mediaReadMu.Lock()
		mediaReadObserver = prev
		mediaReadMu.Unlock()
	}
}

func observeMediaRead(n int) {
	mediaReadMu.Lock()
	fn := mediaReadObserver
	mediaReadMu.Unlock()
	if fn != nil {
		fn(n)
	}
}

func finishMediaOpen(ctx context.Context, file *os.File, dir *os.Root, ident mediaIdentity, admit MediaAdmit) (*MediaFile, error) {
	size := ident.info.Size()
	if size < 0 || size > MaxMediaBytes {
		return nil, ErrTooLarge
	}
	headLen := int(size)
	if headLen > mediaSniffBytes {
		headLen = mediaSniffBytes
	}
	head, err := readAdmitted(ctx, file, headLen, admit)
	if err != nil {
		return nil, err
	}
	kind, mime, width, height := sniffMedia(head, size)
	if size > mediaCap(kind) {
		return nil, ErrTooLarge
	}
	sum := sha256.New()
	if _, err := sum.Write(head); err != nil {
		return nil, err
	}
	jpeg := jpegDimParser{buf: append([]byte(nil), head...)}
	if kind == MediaImage && mime == "image/jpeg" && (width <= 0 || height <= 0) {
		width, height = jpeg.size()
	}
	remaining := size - int64(len(head))
	buf := make([]byte, mediaSniffBytes)
	for remaining > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n := int(remaining)
		if n > len(buf) {
			n = len(buf)
		}
		chunk, err := readAdmittedInto(ctx, file, buf[:n], admit)
		if err != nil {
			return nil, err
		}
		if _, err := sum.Write(chunk); err != nil {
			return nil, err
		}
		if kind == MediaImage && mime == "image/jpeg" && (width <= 0 || height <= 0) {
			_, _ = jpeg.Write(chunk)
			width, height = jpeg.size()
		}
		remaining -= int64(len(chunk))
	}
	if !pixelBoundsOK(kind, width, height) {
		return nil, ErrTooLarge
	}
	st, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err := sameRegular(ident.info, st); err != nil {
		return nil, err
	}
	// A same-inode rewrite or growth during hashing must not be published: the
	// descriptor has to still match the original size, mtime and regular/inode
	// identity. (This is version detection, not an immutable-content guarantee
	// against a writer that also restores metadata.)
	if st.Size() != size || st.ModTime().UnixNano() != ident.info.ModTime().UnixNano() {
		return nil, ErrChanged
	}
	// The published name has to resolve to the same regular descriptor right now,
	// so a swap at the root-relative name during the hash cannot be published.
	named, err := dir.Lstat(ident.clean)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if named.Mode()&os.ModeSymlink != 0 || !named.Mode().IsRegular() || !os.SameFile(named, st) {
		return nil, ErrChanged
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	digest := sum.Sum(nil)
	var hash [32]byte
	copy(hash[:], digest)
	info := MediaInfo{
		Path: ident.clean, Kind: kind, MIME: mime, Size: size,
		ModifiedMS: ident.info.ModTime().UnixMilli(), SHA256: hex.EncodeToString(digest),
		MaxBytes: mediaCap(kind), Width: width, Height: height,
	}
	return &MediaFile{
		file: file, id: ident, info: info, hash: hash, size: size, modNano: ident.info.ModTime().UnixNano(),
	}, nil
}

func readAdmitted(ctx context.Context, file *os.File, n int, admit MediaAdmit) ([]byte, error) {
	if n <= 0 {
		return []byte{}, nil
	}
	buf := make([]byte, n)
	got, err := readAdmittedInto(ctx, file, buf, admit)
	if err != nil {
		return nil, err
	}
	return got, nil
}

func readAdmittedInto(ctx context.Context, file *os.File, buf []byte, admit MediaAdmit) ([]byte, error) {
	if len(buf) == 0 {
		return buf, nil
	}
	if admit != nil {
		if err := admit(ctx, int64(len(buf))); err != nil {
			return nil, err
		}
	}
	// Context cancel is observed between admitted chunks. A single regular-file
	// ReadFull is not interrupted; Unix O_NONBLOCK applies at open, not to an
	// in-flight page-cache read of a regular file.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(file, buf); err != nil {
		return nil, err
	}
	observeMediaRead(len(buf))
	return buf, nil
}
