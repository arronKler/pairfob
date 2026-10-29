package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"
)

type claudeQuotaAuth struct {
	OAuth struct {
		AccessToken  string   `json:"accessToken"`
		ExpiresAt    int64    `json:"expiresAt"`
		Scopes       []string `json:"scopes"`
		Subscription string   `json:"subscriptionType"`
	} `json:"claudeAiOauth"`
}

func claudeQuotaCredentials(ctx context.Context) (claudeQuotaAuth, string) {
	var auth claudeQuotaAuth
	path, err := ClaudeQuotaPath()
	if err != nil {
		return auth, "unavailable"
	}
	raw, err := quotaFile(filepath.Join(filepath.Dir(path), ".credentials.json"), 1024*1024)
	if os.IsNotExist(err) {
		if goruntime.GOOS != "darwin" || os.Getenv("CLAUDE_CONFIG_DIR") != "" {
			return auth, "not_logged_in"
		}
		raw, err = quotaKeychainRead(ctx, "Claude Code-credentials", "", 1024*1024)
		if errors.Is(err, errQuotaKeychainNotFound) {
			return auth, "not_logged_in"
		}
		if err != nil {
			return auth, quotaKeychainStatus(err)
		}
	}
	if err != nil || len(raw) == 0 || json.Unmarshal(raw, &auth) != nil {
		return auth, "auth_required"
	}
	// A store that holds other entries but no subscription login is no login.
	if auth.OAuth.AccessToken == "" {
		return auth, "not_logged_in"
	}
	if len(auth.OAuth.AccessToken) > 16384 {
		return auth, "auth_required"
	}
	if auth.OAuth.ExpiresAt > 0 && auth.OAuth.ExpiresAt <= time.Now().UnixMilli()+60000 {
		return auth, "auth_required"
	}
	{
		found := false
		for _, s := range auth.OAuth.Scopes {
			if s == "user:profile" {
				found = true
			}
		}
		// A login that cannot read usage (a long-lived inference token) is
		// not one a new sign-in of the same kind would fix.
		if !found {
			return auth, "unsupported"
		}
	}
	return auth, ""
}

func locateClaudeQuota(ctx context.Context) (quotaRead, AgentQuota) {
	if os.Getenv("PAIRFOB_CLAUDE_QUOTA_SOURCE") == "statusline" {
		return func(context.Context) AgentQuota { return readClaudeQuota(time.Now()) }, AgentQuota{}
	}
	auth, status := claudeQuotaCredentials(ctx)
	if status != "" {
		return nil, emptyQuota("claude", "oauth", status)
	}
	return func(ctx context.Context) AgentQuota {
		return claudeForbiddenIsNotALogin(ctx, fetchClaudeQuota(ctx, quotaHTTPClient(), auth, time.Now()))
	}, AgentQuota{}
}

// Anthropic answers an expired or invalid token with 401. A 403 comes from
// where the request was made (a network it does not serve), and the scope was
// already checked here: signing in again would not change it, so it is a read
// that failed and not a login to renew.
func claudeForbiddenIsNotALogin(ctx context.Context, q AgentQuota) AgentQuota {
	if q.Status == "auth_required" && quotaForbidden(ctx) {
		q.Status = "unavailable"
	}
	return q
}

// The five-hour and seven-day windows are the plan's allowance. The per-model
// and per-feature windows, and the statusline's spend limit, are each their own.
func markClaudeWindow(w *QuotaWindow) {
	switch strings.ReplaceAll(w.Name, "_", " ") {
	case "five hour", "seven day":
		w.pool, w.headline = "plan", true
	case "spend limit":
		w.pool = "extra"
	default:
		w.pool = quotaPool(w.Name)
	}
}
func fetchClaudeQuota(ctx context.Context, c *http.Client, auth claudeQuotaAuth, now time.Time) AgentQuota {
	q := emptyQuota("claude", "oauth", "unavailable")
	if len(auth.OAuth.Subscription) <= 80 {
		q.Plan = auth.OAuth.Subscription
	}
	var payload map[string]json.RawMessage
	status := quotaJSON(ctx, c, "https://api.anthropic.com/api/oauth/usage", map[string]string{"Authorization": "Bearer " + auth.OAuth.AccessToken, "anthropic-beta": "oauth-2025-04-20"}, nil, &payload)
	if status != "" {
		q.Status = status
		return q
	}
	for _, name := range []string{"five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "seven_day_cowork", "seven_day_routines"} {
		raw := payload[name]
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var w struct {
			Used  *float64 `json:"utilization"`
			Reset string   `json:"resets_at"`
		}
		if json.Unmarshal(raw, &w) != nil || w.Used == nil {
			continue
		}
		minutes := int64(10080)
		if name == "five_hour" {
			minutes = 300
		}
		window := QuotaWindow{Name: strings.ReplaceAll(name, "_", " "), UsedPercent: *w.Used, WindowMinutes: minutes, ResetsAt: quotaReset(w.Reset)}
		markClaudeWindow(&window)
		q.Windows = append(q.Windows, window)
	}
	return finishQuota(q, now)
}
