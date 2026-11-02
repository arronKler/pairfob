// Package audit writes security-relevant daemon events as one JSON object per
// line. It deliberately accepts structured fields so callers can omit secrets.
package audit

import (
	"encoding/json"
	"time"

	"pairfob/internal/logfile"
)

// DefaultMaxBytes is the size audit.log may reach before it rotates to
// audit.log.1.
const DefaultMaxBytes int64 = 8 << 20

// Option configures Open.
type Option func(*config)

type config struct {
	maxBytes int64
}

// WithMaxBytes overrides the rotation cap, mainly so tests can lower it.
func WithMaxBytes(n int64) Option {
	return func(c *config) { c.maxBytes = n }
}

// Logger appends audit events to a rotating file.
type Logger struct {
	w *logfile.Writer
}

// Open creates or opens path, rejecting a symlink or non-regular file. The
// file is kept at mode 0600 and rolls over to "<path>.1".
func Open(path string, opts ...Option) (*Logger, error) {
	c := config{maxBytes: DefaultMaxBytes}
	for _, opt := range opts {
		if opt != nil {
			opt(&c)
		}
	}
	w, err := logfile.Open(path, c.maxBytes)
	if err != nil {
		return nil, err
	}
	return &Logger{w: w}, nil
}

// Event appends one JSON line and syncs it. A marshal or write failure drops
// that event rather than emitting a partial record.
func (l *Logger) Event(op string, fields map[string]any) {
	if l == nil || l.w == nil {
		return
	}
	record := make(map[string]any, len(fields)+2)
	record["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	record["op"] = op
	for k, v := range fields {
		record[k] = v
	}
	b, err := json.Marshal(record)
	if err != nil {
		return
	}
	// One Write per event keeps the whole line in a single file across
	// rotation.
	_, _ = l.w.Write(append(b, '\n'))
	_ = l.w.Sync()
}

// Close releases the audit file.
func (l *Logger) Close() error {
	if l == nil || l.w == nil {
		return nil
	}
	return l.w.Close()
}
