package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// OpenCode Go meters a subscription in rolling, weekly and monthly windows. The
// usage route is the key-authenticated one the console itself uses: a Go API
// key is accepted only there, while the console's browser-session route answers
// 403 to it. The read is a GET; no model turn, CLI process or credential write
// happens.
const openCodeGoUsageURL = "https://opencode.ai/zen/go/v1/usage"

// openCodeGoKeyFile is the fallback for a computer without opencode installed.
const openCodeGoKeyFile = "opencode-go.key"

// openCodeGoWindows is the order the windows appear in, which is also the order
// the phone lists them. The monthly window is left out by plans without one.
var openCodeGoWindows = []struct {
	name    string
	minutes int64
	field   string
}{
	{name: "five hour", minutes: 300, field: "rolling"},
	{name: "seven day", minutes: 10080, field: "weekly"},
	{name: "monthly", field: "monthly"},
}

func locateOpenCodeGoQuota(context.Context) (quotaAccountRead, AgentQuota) {
	key, status := openCodeGoKey()
	if status != "" {
		return nil, emptyQuota("opencode-go", "api", status)
	}
	return func(ctx context.Context) QuotaAccount {
		return fetchOpenCodeGoQuota(ctx, quotaHTTPClient(), key, time.Now())
	}, AgentQuota{}
}

// openCodeGoKey prefers a variable, so a key can be pinned for one daemon, then
// the login opencode itself holds: the Go plan belongs to the account behind
// its OAuth login, and asking for a second key would be asking the user to copy
// a credential that is already on the computer. A key file stays as the last
// resort for a computer without opencode.
func openCodeGoKey() (string, string) {
	if value, ok := quotaEnvKey("OPENCODE_GO_API_KEY"); ok {
		if validQuotaKey(value) {
			return value, ""
		}
		return "", "not_logged_in"
	}
	if key, status := openCodeLogin(); status == "" {
		return key, ""
	}
	path, err := quotaStatePath(openCodeGoKeyFile)
	if err != nil {
		return "", "not_logged_in"
	}
	return quotaKeyFile(path)
}

// openCodeLogin reads the credential opencode stores for itself: the credential
// rows of opencode.db, which 1.2 and later write, then the auth.json older
// versions keep under the data directory. Nothing is refreshed or written; an
// expired token is a login to renew in opencode.
func openCodeLogin() (string, string) {
	dir := openCodeDataDir()
	if dir == "" {
		return "", "not_logged_in"
	}
	if key := openCodeCredential(openCodeDBCredential(dir)); key != "" {
		return key, ""
	}
	if key := openCodeCredential(openCodeAuthFile(dir)); key != "" {
		return key, ""
	}
	return "", "not_logged_in"
}

func openCodeDataDir() string {
	if dir := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dir != "" {
		return filepath.Join(dir, "opencode")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "opencode")
}

// openCodeSQLite is a seam so tests need no sqlite3 binary.
var openCodeSQLite = runOpenCodeSQLite

// openCodeDBCredential asks for the account row, or the opencode-go row when a
// store names one, and returns its stored value.
func openCodeDBCredential(dir string) []byte {
	db := filepath.Join(dir, "opencode.db")
	if info, err := os.Lstat(db); err != nil || !info.Mode().IsRegular() {
		return nil
	}
	out, err := openCodeSQLite(db, `select value from credential where active=1 and integration_id in ('opencode-go','opencode') order by integration_id='opencode-go' desc limit 1;`)
	if err != nil {
		return nil
	}
	var rows []struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(out, &rows) != nil || len(rows) == 0 {
		return nil
	}
	return []byte(rows[0].Value)
}

// openCodeAuthFile returns the entry older opencode versions keep in auth.json.
func openCodeAuthFile(dir string) []byte {
	raw, err := quotaFile(filepath.Join(dir, "auth.json"), 1024*1024)
	if err != nil {
		return nil
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	for _, id := range []string{"opencode-go", "opencode"} {
		if entry := doc[id]; len(entry) > 0 {
			return entry
		}
	}
	return nil
}

// openCodeCredential picks the secret out of one stored entry. A key login has
// key, an OAuth login has access.
func openCodeCredential(raw []byte) string {
	var entry struct {
		Type   string `json:"type"`
		Key    string `json:"key"`
		Access string `json:"access"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &entry) != nil {
		return ""
	}
	value := entry.Key
	if entry.Type == "oauth" {
		value = entry.Access
	}
	value = strings.TrimSpace(value)
	if !validQuotaKey(value) {
		return ""
	}
	return value
}

// runOpenCodeSQLite reads one query with sqlite3, read-only and bounded, the
// way the transcript reader does. A host without sqlite3 has no database
// credential, and the file login still answers.
func runOpenCodeSQLite(db, query string) ([]byte, error) {
	path := ""
	for _, candidate := range []string{"/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			path = candidate
			break
		}
	}
	if path == "" {
		var err error
		if path, err = exec.LookPath("sqlite3"); err != nil {
			return nil, errors.New("no sqlite3 reader")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-init", os.DevNull, "-batch", "-readonly", "-json", "-cmd", ".timeout 1000", db, query)
	cmd.Env = []string{"LC_ALL=C"}
	out := &quotaOutput{limit: 8192}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func fetchOpenCodeGoQuota(ctx context.Context, c *http.Client, key string, now time.Time) QuotaAccount {
	raw, status := openCodeGoUsage(ctx, c, key)
	if status != "" {
		return quotaAccount(emptyQuota("opencode-go", "api", status))
	}
	return parseOpenCodeGoQuota(raw, now)
}

// openCodeGoUsage reads the usage document. It answers its own status words
// because 403 is not a bad login here: the token authenticated, and the account
// behind it has no Go plan, which opencode itself renders as no usage.
func openCodeGoUsage(ctx context.Context, c *http.Client, key string) ([]byte, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openCodeGoUsageURL, nil)
	if err != nil {
		return nil, "unavailable"
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", "pairfob")
	resp, err := c.Do(req)
	if err != nil {
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, "timeout"
		}
		return nil, "unavailable"
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 200:
	case resp.StatusCode == 401:
		return nil, "auth_required"
	case resp.StatusCode == 403:
		return nil, "unavailable"
	case resp.StatusCode == http.StatusTooManyRequests:
		noteQuotaRetry(ctx, resp.Header.Get("Retry-After"), time.Now())
		return nil, "throttled"
	default:
		return nil, "unavailable"
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, "unavailable"
	}
	return raw, ""
}

// parseOpenCodeGoQuota keeps the three windows as used shares. Rolling and
// weekly are always there; the monthly window is absent on a plan without one.
// A missing required window, or a percent that is absent or outside 0-100, is
// a format change rather than zero usage.
func parseOpenCodeGoQuota(raw []byte, now time.Time) QuotaAccount {
	var payload struct {
		Usage map[string]*openCodeGoWindow `json:"usage"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Usage == nil {
		return quotaAccount(emptyQuota("opencode-go", "api", "unavailable"))
	}
	a := QuotaAccount{ID: "opencode-go", Provider: "opencode-go", Source: "api", State: "ok", ObservedAt: now.Unix(), Meters: []QuotaMeter{}}
	for i, window := range openCodeGoWindows {
		w := payload.Usage[window.field]
		if w == nil {
			if i < 2 {
				return quotaAccount(emptyQuota("opencode-go", "api", "unavailable"))
			}
			continue
		}
		if w.Percent == nil || math.IsNaN(*w.Percent) || math.IsInf(*w.Percent, 0) || *w.Percent < 0 || *w.Percent > 100 {
			return quotaAccount(emptyQuota("opencode-go", "api", "unavailable"))
		}
		used := math.Round(*w.Percent*10) / 10
		a.Meters = append(a.Meters, QuotaMeter{
			Kind: "quota", Name: window.name, Pool: "plan", Headline: true,
			UsedPercent: &used, WindowMinutes: window.minutes, ResetsAt: quotaReset(w.ResetsAt),
		})
	}
	return finishQuotaAccount(a)
}

// openCodeGoWindow is one window of the usage document. percent is what has
// been used, and resetsAt is the end of the window.
type openCodeGoWindow struct {
	Percent  *float64 `json:"percent"`
	ResetsAt string   `json:"resetsAt"`
}
