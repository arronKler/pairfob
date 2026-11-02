// Package logfile writes an append-only file that rolls over to a single
// backup once it reaches a size cap. One Write call always lands in exactly
// one file: rotation happens before the write, and a failed rotation falls
// back to the active descriptor so no bytes are lost.
package logfile

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

// Writer is a concurrency-safe append-only file with one rotated backup at
// "<path>.1".
type Writer struct {
	mu     sync.Mutex
	path   string
	max    int64
	f      *os.File
	size   int64
	moved  bool
	closed bool
}

// Open creates or opens path in append mode. A non-positive maxBytes disables
// rotation. The file is kept at mode 0600 and must be a regular file.
func Open(path string, maxBytes int64) (*Writer, error) {
	f, size, err := openActive(path)
	if err != nil {
		return nil, err
	}
	return &Writer{path: path, max: maxBytes, f: f, size: size}, nil
}

func openActive(path string) (*os.File, int64, error) {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, 0, fmt.Errorf("logfile path must be a regular file")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, 0, err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, 0, fmt.Errorf("logfile path must be a regular file")
	}
	if err := f.Chmod(0600); err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

// Write appends p, rotating first when the write would exceed the cap. If the
// fresh file cannot be opened, p still goes to the current descriptor and the
// next write retries the rotation.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	if w.max > 0 && w.size > 0 && w.size+int64(len(p)) > w.max {
		w.rotateLocked()
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// rotateLocked moves the active file to the backup and swaps in a fresh file.
// It leaves the current descriptor in place on any failure, so callers keep
// writing without losing data and rotation is retried on a later write.
func (w *Writer) rotateLocked() {
	if !w.moved {
		if err := os.Rename(w.path, w.path+".1"); err != nil {
			return
		}
		w.moved = true
	}
	f, size, err := openActive(w.path)
	if err != nil {
		return
	}
	old := w.f
	w.f = f
	w.size = size
	w.moved = false
	_ = old.Close()
}

// Sync flushes the active file to stable storage.
func (w *Writer) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	return w.f.Sync()
}

// Close releases the active descriptor.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	return w.f.Close()
}
