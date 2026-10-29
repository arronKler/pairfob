package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const openCodeGoUsageBody = `{"usage":{
  "rolling":{"status":"ok","percent":12.5,"resetsAt":"2027-01-15T12:00:00.000Z"},
  "weekly":{"status":"ok","percent":83,"resetsAt":"2027-01-20T00:00:00Z"},
  "monthly":{"status":"ok","percent":100,"resetsAt":"2027-02-01T00:00:00Z"}}}`

func TestOpenCodeGoWindowsBecomeUsedShares(t *testing.T) {
	now := time.Unix(1800000000, 0)
	c := quotaFixtureClient(t, "opencode.ai", "/zen/go/v1/usage", "Bearer oc_sk-test-key", 200, openCodeGoUsageBody)
	a := fetchOpenCodeGoQuota(context.Background(), c, "oc_sk-test-key", now)
	if a.ID != "opencode-go" || a.Provider != "opencode-go" || a.Source != "api" || a.State != "ok" || a.ObservedAt != now.Unix() || len(a.Meters) != 3 {
		t.Fatalf("%+v", a)
	}
	want := []struct {
		name    string
		minutes int64
		percent float64
		reset   time.Time
	}{
		{"five hour", 300, 12.5, time.Date(2027, 1, 15, 12, 0, 0, 0, time.UTC)},
		{"seven day", 10080, 83, time.Date(2027, 1, 20, 0, 0, 0, 0, time.UTC)},
		{"monthly", 0, 100, time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC)},
	}
	for i, w := range want {
		m := a.Meters[i]
		if m.Kind != "quota" || m.Name != w.name || m.Pool != "plan" || !m.Headline || m.UsedPercent == nil || *m.UsedPercent != w.percent ||
			m.WindowMinutes != w.minutes || m.ResetsAt != w.reset.Unix() || m.Used != nil || m.Unit != "" || !validQuotaMeter(m) {
			t.Fatalf("meter %d: %+v", i, m)
		}
	}
}

func TestOpenCodeGoMonthlyWindowIsOptional(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := `{"usage":{"rolling":{"percent":0},"weekly":{"percent":99.96}}}`
	a := parseOpenCodeGoQuota([]byte(body), now)
	// A share is rounded to a tenth, never left as a float artefact.
	if a.State != "ok" || len(a.Meters) != 2 || *a.Meters[0].UsedPercent != 0 || *a.Meters[1].UsedPercent != 100 {
		t.Fatalf("%+v", a)
	}
	// A window without a reset is still a share.
	if a.Meters[0].ResetsAt != 0 || a.Meters[1].ResetsAt != 0 {
		t.Fatalf("%+v", a)
	}
}

func TestOpenCodeGoParsingFailsClosed(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, body := range []string{
		`{}`, `{"usage":null}`, `{"usage":[]}`,
		`{"usage":{"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":10}}}`,
		`{"usage":{"rolling":{},"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":null},"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":100.5},"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":-1},"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":"10"},"weekly":{"percent":10}}}`,
		`{"usage":{"rolling":{"percent":10},"weekly":{"percent":10},"monthly":{}}}`,
	} {
		if a := parseOpenCodeGoQuota([]byte(body), now); a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 || a.ObservedAt != 0 {
			t.Fatalf("%s: %+v", body, a)
		}
	}
}

func TestOpenCodeGoHTTPRefusalsKeepTheirCause(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for code, want := range map[int][2]string{
		401: {"needs_action", "relogin"},
		// An authenticated account without the Go plan is not a login to redo.
		403: {"failed", "unavailable"},
		429: {"throttled", ""}, 500: {"failed", "unavailable"},
	} {
		c := quotaFixtureClient(t, "opencode.ai", "/zen/go/v1/usage", "Bearer oc_sk-test-key", code, `{}`)
		if a := fetchOpenCodeGoQuota(context.Background(), c, "oc_sk-test-key", now); a.State != want[0] || a.Reason != want[1] || len(a.Meters) != 0 {
			t.Fatalf("HTTP %d: %+v", code, a)
		}
	}
}

// openCodeKeyFixture isolates the state directory, the home and the data
// directory, so a real opencode login on the test host cannot answer.
func openCodeKeyFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	t.Setenv("OPENCODE_GO_API_KEY", "")
	return home
}

func writeOpenCodeFile(t *testing.T, body string, parts ...string) {
	t.Helper()
	path := filepath.Join(parts...)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestOpenCodeGoKeyPrefersTheEnvironmentThenTheCLIThenAFile(t *testing.T) {
	home := openCodeKeyFixture(t)
	t.Setenv("OPENCODE_GO_API_KEY", "oc_sk-from-env")
	if key, status := openCodeGoKey(); key != "oc_sk-from-env" || status != "" {
		t.Fatalf("env: %q %q", key, status)
	}
	t.Setenv("OPENCODE_GO_API_KEY", "")
	if key, status := openCodeGoKey(); key != "" || status != "not_logged_in" {
		t.Fatalf("no login: %q %q", key, status)
	}
	// The state directory answers when the computer never ran opencode.
	writeOpenCodeFile(t, "oc_sk-from-file\n", os.Getenv("PAIRFOB_STATE_DIR"), "opencode-go.key")
	if key, status := openCodeGoKey(); key != "oc_sk-from-file" || status != "" {
		t.Fatalf("file: %q %q", key, status)
	}
	// A CLI login is the credential the user already made, so it wins.
	writeOpenCodeFile(t, `{"opencode":{"type":"api","key":"oc_sk-from-cli"}}`, home, ".local", "share", "opencode", "auth.json")
	if key, status := openCodeGoKey(); key != "oc_sk-from-cli" || status != "" {
		t.Fatalf("CLI login: %q %q", key, status)
	}
}

func TestOpenCodeGoReadsTheCredentialTableFirst(t *testing.T) {
	home := openCodeKeyFixture(t)
	dir := filepath.Join(home, ".local", "share", "opencode")
	writeOpenCodeFile(t, "db", dir, "opencode.db")
	writeOpenCodeFile(t, `{"opencode":{"type":"api","key":"oc_sk-from-legacy"}}`, dir, "auth.json")
	restore := openCodeSQLite
	t.Cleanup(func() { openCodeSQLite = restore })
	var query string
	openCodeSQLite = func(db, sql string) ([]byte, error) {
		query = sql
		if db != filepath.Join(dir, "opencode.db") {
			t.Errorf("read %q, want the CLI database", db)
		}
		return []byte(`[{"value":"{\"type\":\"oauth\",\"access\":\"oc_oauth-from-db\",\"refresh\":\"rt\",\"expires\":1795789619434}"}]`), nil
	}
	if key, status := openCodeGoKey(); key != "oc_oauth-from-db" || status != "" {
		t.Fatalf("db: %q %q", key, status)
	}
	if !strings.Contains(query, "'opencode-go'") || !strings.Contains(query, "'opencode'") {
		t.Fatalf("query does not cover both rows: %s", query)
	}
}

func TestOpenCodeGoFallsBackToTheLegacyFileAndRefusesJunk(t *testing.T) {
	home := openCodeKeyFixture(t)
	dir := filepath.Join(home, ".local", "share", "opencode")
	for _, tc := range []struct {
		body, want, status string
	}{
		{`{"opencode-go":{"type":"api","key":"oc_sk-go-key"}}`, "oc_sk-go-key", ""},
		{`{"opencode":{"type":"oauth","access":"oc_oauth-access","refresh":"rt"}}`, "oc_oauth-access", ""},
		{`{"opencode":{"type":"oauth","refresh":"rt"}}`, "", "not_logged_in"},
		{`{"opencode":{"type":"api","key":"short"}}`, "", "not_logged_in"},
		{`{"opencode":{"type":"api","key":"export KEY=x"}}`, "", "not_logged_in"},
		{`[]`, "", "not_logged_in"},
		{`not json`, "", "not_logged_in"},
	} {
		writeOpenCodeFile(t, tc.body, dir, "auth.json")
		if key, status := openCodeGoKey(); key != tc.want || status != tc.status {
			t.Fatalf("%s: %q %q", tc.body, key, status)
		}
	}
}

func TestOpenCodeGoSitsOnlyAfterTheFirstWire(t *testing.T) {
	openCodeKeyFixture(t)
	var found bool
	for _, p := range quotaAccountProviders {
		if p.name != "opencode-go" {
			continue
		}
		found = true
		reading := p.read(context.Background())
		if reading.Legacy != nil || reading.Account.State != "not_configured" || reading.Account.Reason != "no_login" {
			t.Fatalf("%+v", reading)
		}
	}
	if !found {
		t.Fatal("opencode-go is not a quota account provider")
	}
}
