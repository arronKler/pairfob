package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

// OpenDownloadContext authorizes a live workspace file for the P2P-only
// download path. Unlike OpenMediaContext it does not hash the whole file:
// only the sniffed head is read at Open, and every ReadChunk revalidates the
// same regular file. The revision lets a resuming client notice a changed
// file without paying a second full-file read.
func (i *Inspector) OpenDownloadContext(
	ctx context.Context,
	root, relative string,
	maxBytes int64,
	admit MediaAdmit,
) (*MediaFile, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if maxBytes <= 0 {
		maxBytes = MaxDownloadBytes
	}
	file, dir, ident, err := openAuthorizedRegular(root, relative)
	if err != nil {
		return nil, err
	}
	opened, err := finishDownloadOpen(ctx, file, dir, ident, maxBytes, admit)
	if err != nil {
		_ = file.Close()
		_ = dir.Close()
		return nil, err
	}
	opened.dir = dir
	return opened, nil
}

func finishDownloadOpen(
	ctx context.Context,
	file *os.File,
	dir *os.Root,
	ident mediaIdentity,
	maxBytes int64,
	admit MediaAdmit,
) (*MediaFile, error) {
	size := ident.info.Size()
	if size < 0 || size > maxBytes {
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
	kind, mime, _, _ := sniffMedia(head)
	// A download has no preview cap: any regular file under maxBytes can be
	// saved, including a large image or video.
	st, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err := sameRegular(ident.info, st); err != nil {
		return nil, err
	}
	if st.Size() != size || st.ModTime().UnixNano() != ident.info.ModTime().UnixNano() {
		return nil, ErrChanged
	}
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
	info := MediaInfo{
		Path:       ident.clean,
		Kind:       kind,
		MIME:       mime,
		Size:       size,
		ModifiedMS: ident.info.ModTime().UnixMilli(),
		Revision:   downloadRevision(head, size, ident.info.ModTime().UnixNano()),
		MaxBytes:   maxBytes,
	}
	return &MediaFile{
		file: file, id: ident, info: info, size: size, modNano: ident.info.ModTime().UnixNano(),
	}, nil
}

func downloadRevision(head []byte, size, modNano int64) string {
	sum := sha256.New()
	_, _ = sum.Write(head)
	var fixed [16]byte
	binary.BigEndian.PutUint64(fixed[:8], uint64(size))
	binary.BigEndian.PutUint64(fixed[8:], uint64(modNano))
	_, _ = sum.Write(fixed[:])
	return hex.EncodeToString(sum.Sum(nil))
}
