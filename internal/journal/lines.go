package journal

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// maxTraceLine bounds one transcript record the trace and History readers will
// decode. A single tool output can exceed it; such a record is skipped and the
// page marked truncated instead of failing every older page.
const maxTraceLine = 8 << 20

// forEachLineBytes calls fn for each line of data without copying it, including
// a final unterminated one. size is the number of bytes the line occupied,
// newline included. Lines longer than limit are reported with oversized=true
// and an empty body. fn returns false to stop early.
func forEachLineBytes(data []byte, limit int, fn func(line []byte, size int, oversized bool) bool) {
	for pos := 0; pos < len(data); {
		size := len(data) - pos
		if newline := bytes.IndexByte(data[pos:], '\n'); newline >= 0 {
			size = newline + 1
		}
		segment := data[pos : pos+size]
		body := segment
		if end := len(body); end > 0 && body[end-1] == '\n' {
			body = body[:end-1]
		}
		// The limit is measured before the carriage return is trimmed, as the
		// reader above does, so both readers classify a line the same way.
		oversized := len(body) > limit
		if oversized {
			body = body[:0]
		} else if end := len(body); end > 0 && body[end-1] == '\r' {
			body = body[:end-1]
		}
		if !fn(body, size, oversized) {
			return
		}
		pos += size
	}
}

// forEachLine calls fn for each line of r, including a final unterminated one.
// size is the number of bytes the line occupied, newline included. Lines longer
// than limit are reported with oversized=true and an empty body. fn returns
// false to stop early.
func forEachLine(r io.Reader, limit int, fn func(line []byte, size int, oversized bool) bool) error {
	reader := bufio.NewReaderSize(r, 64<<10)
	var line []byte
	size := 0
	oversized := false
	for {
		chunk, err := reader.ReadSlice('\n')
		size += len(chunk)
		if !oversized {
			if len(line)+len(chunk) > limit+1 {
				oversized, line = true, line[:0]
			} else {
				line = append(line, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if size > 0 {
			body := bytes.TrimSuffix(bytes.TrimSuffix(line, []byte("\n")), []byte("\r"))
			if !fn(body, size, oversized) {
				return nil
			}
		}
		if err != nil {
			return nil
		}
		line, size, oversized = line[:0], 0, false
	}
}
