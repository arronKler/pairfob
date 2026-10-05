package journal

import (
	"bytes"
	"io"
	"os"
)

// transcript is the record stream a line parser reads: an agent's own log
// file, or the lines rendered from a session store (store.go). Offsets into
// it are what history cursors and trace detail refs carry.
type transcript struct {
	// name identifies the stream to the page cache: the file path, or the
	// store session.
	name string
	size int64
	// modified changes whenever the bytes may have.
	modified int64
	reader   io.ReaderAt
	file     *os.File
}

func (r *Reader) openTranscript(ref Ref, refreshMissing bool) (*transcript, error) {
	if storeAgent(ref.Agent) {
		snapshot, err := r.loadStore(ref, refreshMissing)
		if err != nil {
			return nil, err
		}
		return &transcript{
			name: "store:" + refFingerprint(ref), size: int64(len(snapshot.data)), modified: snapshot.revision,
			reader: bytes.NewReader(snapshot.data),
		}, nil
	}
	path, err := r.transcriptPath(ref, refreshMissing)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	return &transcript{name: path, size: info.Size(), modified: info.ModTime().UnixNano(), reader: file, file: file}, nil
}

func (t *transcript) Close() {
	if t.file != nil {
		t.file.Close()
	}
}

// from reads the stream from offset to the size it had when opened.
func (t *transcript) from(offset int64) io.Reader {
	return io.NewSectionReader(t.reader, offset, t.size-offset)
}

// unchanged reports whether a log file still has the size and time it was
// opened with. Rendered store lines are a snapshot and cannot change.
func (t *transcript) unchanged() bool {
	if t.file == nil {
		return true
	}
	info, err := t.file.Stat()
	return err == nil && info.Size() == t.size && info.ModTime().UnixNano() == t.modified
}
