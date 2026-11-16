package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Kiro (AWS Kiro CLI) reports its subscription allowance through the
// CodeWhisperer GetUsageLimits call the CLI itself makes. The login lives in the
// CLI's own SQLite database, so this read needs no key and starts no CLI
// process. Only the access token already on the computer is used; nothing is
// refreshed, written or logged.
const (
	kiroUsageURL    = "https://codewhisperer.us-east-1.amazonaws.com/"
	kiroUsageTarget = "AmazonCodeWhispererService.GetUsageLimits"
)

// kiroAuthRow is the key the CLI stores its social (Google/GitHub) login under.
const kiroAuthRow = "kirocli:social:token"

func locateKiroQuota(_ context.Context) (quotaAccountRead, AgentQuota) {
	db, status := kiroDatabasePath()
	if status != "" {
		return nil, emptyQuota("kiro", "local_api", status)
	}
	if !kiroHasLogin(db) {
		return nil, emptyQuota("kiro", "local_api", "not_logged_in")
	}
	return func(ctx context.Context) QuotaAccount {
		return fetchKiroQuota(ctx, quotaHTTPClient(), db, time.Now())
	}, AgentQuota{}
}

// kiroDatabasePath follows the CLI: the data directory is
// ~/Library/Application Support/kiro-cli on macOS and $XDG_DATA_HOME/kiro-cli
// elsewhere. Kiro's own config directory (~/.kiro) holds no login.
func kiroDatabasePath() (string, string) {
	dir := os.Getenv("KIRO_DATA_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "not_installed"
		}
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			dir = filepath.Join(xdg, "kiro-cli")
		} else if os.PathSeparator == '\\' {
			dir = filepath.Join(home, "AppData", "Local", "kiro-cli")
		} else if _, err := os.Stat(filepath.Join(home, "Library", "Application Support")); err == nil {
			dir = filepath.Join(home, "Library", "Application Support", "kiro-cli")
		} else {
			dir = filepath.Join(home, ".local", "share", "kiro-cli")
		}
	}
	db := filepath.Join(dir, "data.sqlite3")
	if info, err := os.Stat(db); err != nil || !info.Mode().IsRegular() {
		return "", "not_installed"
	}
	return db, ""
}

// kiroHasLogin looks for the login before any request, so a computer that never
// ran the CLI reports "no login" rather than a failure to ask.
func kiroHasLogin(db string) bool {
	raw, err := quotaSQLite(db, "SELECT value FROM auth_kv WHERE key='"+kiroAuthRow+"' LIMIT 1")
	return err == nil && len(kiroToken(raw)) > 0
}

// kiroToken reads the access token out of the CLI's stored row.
func kiroToken(raw []byte) []byte {
	var rows []struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(raw, &rows) != nil || len(rows) != 1 {
		return nil
	}
	var login struct {
		AccessToken string `json:"access_token"`
		ProfileARN  string `json:"profile_arn"`
	}
	body := []byte(rows[0].Value)
	if json.Unmarshal(body, &login) != nil || !validQuotaKey(login.AccessToken) {
		return nil
	}
	return body
}

func fetchKiroQuota(ctx context.Context, c *http.Client, db string, now time.Time) QuotaAccount {
	raw, err := quotaSQLite(db, "SELECT value FROM auth_kv WHERE key='"+kiroAuthRow+"' LIMIT 1")
	if err != nil {
		return quotaAccount(emptyQuota("kiro", "local_api", "unavailable"))
	}
	login := kiroToken(raw)
	if login == nil {
		return quotaAccount(emptyQuota("kiro", "local_api", "not_logged_in"))
	}
	var creds struct {
		AccessToken string `json:"access_token"`
		ProfileARN  string `json:"profile_arn"`
	}
	if json.Unmarshal(login, &creds) != nil || !validQuotaKey(creds.AccessToken) {
		return quotaAccount(emptyQuota("kiro", "local_api", "not_logged_in"))
	}
	usage, status := kiroUsage(ctx, c, creds.AccessToken, creds.ProfileARN)
	if status != "" {
		return quotaAccount(emptyQuota("kiro", "local_api", status))
	}
	return parseKiroQuota(usage, now)
}

// kiroUsage asks GetUsageLimits. 401 is an expired login rather than an account
// to ask again, and 403 is a logged-in account without a subscription.
func kiroUsage(ctx context.Context, c *http.Client, token, profileARN string) ([]byte, string) {
	body, err := json.Marshal(map[string]string{"origin": "AI_EDITOR", "resourceType": "AGENTIC_REQUEST", "profileArn": profileARN})
	if err != nil {
		return nil, "unavailable"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, kiroUsageURL, bytes.NewReader(body))
	if err != nil {
		return nil, "unavailable"
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", kiroUsageTarget)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		var timeout interface{ Timeout() bool }
		if errors.As(err, &timeout) && timeout.Timeout() {
			return nil, "timeout"
		}
		return nil, "unavailable"
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return nil, "auth_required"
	case http.StatusForbidden:
		return nil, "unsupported"
	case http.StatusTooManyRequests:
		noteQuotaRetry(ctx, resp.Header.Get("Retry-After"), time.Now())
		return nil, "throttled"
	default:
		return nil, "unavailable"
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 || !json.Valid(raw) {
		return nil, "unavailable"
	}
	return raw, ""
}

// parseKiroQuota turns the usage document into one account. Each resource type
// is its own pool, and the first is the account's headline. A breakdown with no
// usable cap is skipped; a document with none left is a failed read, never zero
// usage.
func parseKiroQuota(raw []byte, now time.Time) QuotaAccount {
	var payload struct {
		Subscription struct {
			Title string `json:"subscriptionTitle"`
		} `json:"subscriptionInfo"`
		Breakdown []struct {
			ResourceType string  `json:"resourceType"`
			DisplayName  string  `json:"displayName"`
			Unit         string  `json:"unit"`
			UsageLimit   float64 `json:"usageLimitWithPrecision"`
			Usage        float64 `json:"currentUsageWithPrecision"`
			Reset        float64 `json:"nextDateReset"`
		} `json:"usageBreakdownList"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return quotaAccount(emptyQuota("kiro", "local_api", "unavailable"))
	}
	a := QuotaAccount{ID: "kiro", Provider: "kiro", Source: "local_api", State: "ok", Plan: payload.Subscription.Title}
	for _, b := range payload.Breakdown {
		if b.UsageLimit <= 0 || b.Usage < 0 || len(a.Meters) >= quotaMaxMeters {
			continue
		}
		name := "usage"
		if b.DisplayName != "" && len(b.DisplayName) <= 160 {
			name = b.DisplayName
		}
		used := b.Usage / b.UsageLimit * 100
		if used > 100 {
			used = 100
		}
		m := QuotaMeter{
			Kind: "quota", Name: name, Pool: quotaPool(b.ResourceType), Headline: len(a.Meters) == 0,
			UsedPercent: &used, ResetsAt: quotaResetFloat(b.Reset),
		}
		// The counts are shown only when both are whole numbers of the provider's
		// own unit; a fractional credit is not a count to print.
		if units, ok := kiroUnit(b.Unit); ok && wholeCount(b.Usage) && wholeCount(b.UsageLimit) {
			usedCount := int64(b.Usage)
			limitCount := int64(b.UsageLimit)
			if usedCount <= quotaMaxCount && limitCount > 0 && limitCount <= quotaMaxCount {
				m.Used, m.Limit, m.Unit = &usedCount, &limitCount, units
			}
		}
		if !validQuotaMeter(m) {
			return quotaAccount(emptyQuota("kiro", "local_api", "unavailable"))
		}
		a.Meters = append(a.Meters, m)
	}
	if len(a.Meters) == 0 {
		return quotaAccount(emptyQuota("kiro", "local_api", "unavailable"))
	}
	if len(a.Plan) > 80 {
		a.Plan = ""
	}
	a.ObservedAt = now.Unix()
	return finishQuotaAccount(a)
}

// kiroUnit maps a provider unit to a wire unit. Credits and requests are what
// Kiro's own allowance is counted in; anything else is left uncounted.
func kiroUnit(unit string) (string, bool) {
	switch unit {
	case "INVOCATIONS":
		return "requests", true
	case "CREDIT":
		return "credits", true
	}
	return "", false
}

// wholeCount reports whether a provider amount is an exact whole number, so a
// fractional credit is never truncated into a count.
func wholeCount(v float64) bool {
	return v >= 0 && v == math.Trunc(v) && v <= float64(quotaMaxCount)
}

// quotaResetFloat reads a provider reset given as fractional Unix seconds.
func quotaResetFloat(v float64) int64 {
	if v <= 0 || v > float64(quotaMaxTime) {
		return 0
	}
	return int64(v)
}
