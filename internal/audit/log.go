// Package audit writes security-relevant daemon events as one JSON object per
// line. It deliberately accepts structured fields so callers can omit secrets.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

type Logger struct {
	mu sync.Mutex
	f  *os.File
}

func Open(path string) (*Logger, error) {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("audit path must be a regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0600); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &Logger{f: f}, nil
}

func (l *Logger) Event(op string, fields map[string]any) {
	if l == nil || l.f == nil {
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
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.f.Write(append(b, '\n'))
	_ = l.f.Sync()
}

func (l *Logger) Close() error {
	if l == nil || l.f == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}
