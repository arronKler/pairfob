package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Quota responses and credentials never enter logs or errors returned to the
// phone. Redirects are disabled so authenticated requests stay on their origin.
func quotaHTTPClient() *http.Client {
	return &http.Client{Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func quotaJSON(ctx context.Context, c *http.Client, url string, headers map[string]string, body []byte, dst any) string {
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return "unavailable"
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return "timeout"
		}
		return "unavailable"
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		if resp.StatusCode == 403 {
			noteQuotaForbidden(ctx)
		}
		return "auth_required"
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		noteQuotaRetry(ctx, resp.Header.Get("Retry-After"), time.Now())
		return "throttled"
	}
	if resp.StatusCode != 200 {
		return "unavailable"
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 || json.Unmarshal(raw, dst) != nil {
		return "unavailable"
	}
	return ""
}

func quotaFile(path string, limit int) ([]byte, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > int64(limit) {
		return nil, errors.New("invalid quota credential file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil || len(raw) > limit {
		return nil, errors.New("quota credential unavailable")
	}
	return raw, nil
}

// quotaKeyFileLimit leaves room for a trailing newline or a pasted label while
// still refusing anything that is obviously a document rather than a key.
const quotaKeyFileLimit = 16384

// validQuotaKey accepts a single printable token. A file holding an exported
// line, a comment or several lines is a mistake to fix, never a key.
func validQuotaKey(key string) bool {
	if len(key) < 8 || len(key) > 4096 {
		return false
	}
	for _, r := range key {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

// quotaStatePath is where a provider's key file lives: the daemon's state
// directory, which is ~/.config/pairfob unless the operator moved it.
func quotaStatePath(name string) (string, error) {
	dir := os.Getenv("PAIRFOB_STATE_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".config", "pairfob")
	}
	return filepath.Join(dir, name), nil
}

// quotaEnvKey returns the first named variable that holds a value.
func quotaEnvKey(names ...string) (string, bool) {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value, true
		}
	}
	return "", false
}

// quotaKeyFile reads one key file. A missing file is no login; a file that
// cannot be read is one to save again; a file that holds anything but a single
// key is not a login at all.
func quotaKeyFile(path string) (string, string) {
	raw, err := quotaFile(path, quotaKeyFileLimit)
	if os.IsNotExist(err) {
		return "", "not_logged_in"
	}
	if err != nil {
		return "", "auth_required"
	}
	key := strings.TrimSpace(string(raw))
	if !validQuotaKey(key) {
		return "", "not_logged_in"
	}
	return key, ""
}

// quotaKey finds a provider's key: an environment variable first, for a daemon
// started from a shell, then the file for the installed service, which does
// not inherit one. A variable that is set but unusable is a mistake to fix,
// not a reason to read a file the user may not know about.
func quotaKey(file string, names ...string) (string, string) {
	if value, ok := quotaEnvKey(names...); ok {
		if validQuotaKey(value) {
			return value, ""
		}
		return "", "not_logged_in"
	}
	path, err := quotaStatePath(file)
	if err != nil {
		return "", "not_logged_in"
	}
	return quotaKeyFile(path)
}

type quotaOutput struct {
	bytes.Buffer
	limit int
}

func (b *quotaOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("quota command output exceeds limit")
	}
	return b.Buffer.Write(p)
}
func quotaCommand(parent context.Context, limit int, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 200 * time.Millisecond
	out := &quotaOutput{limit: limit}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return nil, errors.New("quota command unavailable")
	}
	return out.Bytes(), nil
}
func quotaReset(raw string) int64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		if t, err := time.Parse(layout, raw); err == nil && t.Unix() > 0 && t.Unix() <= 4102444800 {
			return t.Unix()
		}
	}
	return 0
}
func finishQuota(q AgentQuota, now time.Time) AgentQuota {
	if len(q.Plan) > 80 {
		q.Plan = ""
	}
	q.ObservedAt = now.Unix()
	if len(q.Windows) == 0 || len(q.Windows) > 32 {
		q.Status = "unavailable"
		q.Windows = []QuotaWindow{}
		return q
	}
	q.Status = "ok"
	for _, w := range q.Windows {
		if !validQuotaWindow(w) {
			q.Status = "unavailable"
			q.Windows = []QuotaWindow{}
			return q
		}
		if w.ResetsAt > 0 && w.ResetsAt <= now.Unix() {
			q.Status = "stale"
		}
	}
	return q
}
