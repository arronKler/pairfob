package workspace

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

const mediaSniffBytes = 64 * 1024

// MediaAdmit reserves disk quota for the next bounded read/hash chunk.
// A nil admit skips quota (workspace unit tests). Callers must admit before
// any filesystem read. Tokens already taken are never refunded.
type MediaAdmit func(ctx context.Context, n int64) error

type mediaIdentity struct {
	root  string
	clean string
	info  os.FileInfo
}

// MediaFile is an authorized, still-open regular file used for chunked reads.
type MediaFile struct {
	mu      sync.Mutex
	file    *os.File
	dir     *os.Root
	closed  bool
	id      mediaIdentity
	info    MediaInfo
	hash    [32]byte
	size    int64
	modNano int64
}

func (m *MediaFile) Info() MediaInfo { return m.info }

func (m *MediaFile) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeLocked()
}

func (m *MediaFile) closeLocked() error {
	if m.closed {
		return nil
	}
	m.closed = true
	var err error
	if m.file != nil {
		err = m.file.Close()
		m.file = nil
	}
	if m.dir != nil {
		_ = m.dir.Close()
		m.dir = nil
	}
	return err
}

func (i *Inspector) OpenMedia(root, relative string) (*MediaFile, error) {
	return i.OpenMediaContext(context.Background(), root, relative, nil)
}

func (i *Inspector) OpenMediaContext(ctx context.Context, root, relative string, admit MediaAdmit) (*MediaFile, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	file, dir, ident, err := openAuthorizedRegular(root, relative)
	if err != nil {
		return nil, err
	}
	opened, err := finishMediaOpen(ctx, file, dir, ident, admit)
	if err != nil {
		_ = file.Close()
		_ = dir.Close()
		return nil, err
	}
	opened.dir = dir
	return opened, nil
}

func (m *MediaFile) Recheck() error {
	if m == nil {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.recheckLocked()
}

func (m *MediaFile) recheckLocked() error {
	if m.closed || m.file == nil || m.dir == nil {
		return ErrNotFound
	}
	st, err := m.file.Stat()
	if err != nil {
		return err
	}
	if err := sameRegular(m.id.info, st); err != nil {
		return err
	}
	if st.Size() != m.size || st.ModTime().UnixNano() != m.modNano {
		return ErrChanged
	}
	named, err := m.dir.Lstat(m.id.clean)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	if !named.Mode().IsRegular() || !os.SameFile(named, st) {
		return ErrChanged
	}
	return nil
}

func (m *MediaFile) ReadChunk(offset, length int64) ([]byte, bool, error) {
	if m == nil {
		return nil, false, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.recheckLocked(); err != nil {
		return nil, false, err
	}
	if offset < 0 || length < 1 || length > MediaChunkBytes || offset > m.size {
		return nil, false, ErrInvalidRange
	}
	if offset == m.size {
		return []byte{}, true, nil
	}
	remain := m.size - offset
	if length > remain {
		length = remain
	}
	buf := make([]byte, length)
	n, err := m.file.ReadAt(buf, offset)
	if n != int(length) {
		if err == nil {
			err = ErrChanged
		}
		return nil, false, err
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false, err
	}
	return buf, offset+int64(n) >= m.size, nil
}

func sameRegular(left, right os.FileInfo) error {
	if left == nil || right == nil || !left.Mode().IsRegular() || !right.Mode().IsRegular() {
		return ErrInvalidPath
	}
	if !os.SameFile(left, right) {
		return ErrChanged
	}
	return nil
}
