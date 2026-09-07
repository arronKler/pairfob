package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func copilotQuotaToken(ctx context.Context) string {
	if token := strings.TrimSpace(os.Getenv("COPILOT_GITHUB_TOKEN")); token != "" {
		return token
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		dir = filepath.Join(home, ".config")
	}
	// Read only the public GitHub host; never send enterprise credentials to github.com.
	tokens := map[string]bool{}
	for _, file := range []string{"hosts.json", "apps.json"} {
		raw, err := quotaFile(filepath.Join(dir, "github-copilot", file), 1024*1024)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return ""
		}
		var hosts map[string]struct {
			Token string `json:"oauth_token"`
		}
		if json.Unmarshal(raw, &hosts) != nil {
			return ""
		}
		for host, account := range hosts {
			if (host == "github.com" || strings.HasPrefix(host, "github.com:")) && account.Token != "" {
				tokens[account.Token] = true
			}
		}
	}
	if len(tokens) == 1 {
		for token := range tokens {
			return token
		}
	}
	if len(tokens) > 1 {
		return ""
	} // Require explicit selection across both files.

	raw, err := quotaCommand(ctx, 16384, "gh", "auth", "token", "--hostname", "github.com")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
func readCopilotQuota(ctx context.Context) AgentQuota {
	token := copilotQuotaToken(ctx)
	if token == "" || len(token) > 16384 {
		return emptyQuota("copilot", "github_api", "auth_required")
	}
	return fetchCopilotQuota(ctx, quotaHTTPClient(), token, time.Now())
}
func fetchCopilotQuota(ctx context.Context, c *http.Client, token string, now time.Time) AgentQuota {
	q := emptyQuota("copilot", "github_api", "unavailable")
	var raw json.RawMessage
	status := quotaJSON(ctx, c, "https://api.github.com/copilot_internal/user", map[string]string{"Authorization": "token " + token, "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01"}, nil, &raw)
	if status != "" {
		q.Status = status
		return q
	}
	return parseCopilotQuota(raw, now)
}
func parseCopilotQuota(raw []byte, now time.Time) AgentQuota {
	q := emptyQuota("copilot", "github_api", "unavailable")
	var payload struct {
		Plan   string `json:"copilot_plan"`
		Reset  string `json:"quota_reset_date"`
		Quotas map[string]struct {
			Remaining   *float64 `json:"percent_remaining"`
			Unlimited   bool     `json:"unlimited"`
			Entitlement *float64 `json:"entitlement"`
		} `json:"quota_snapshots"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return q
	}
	q.Plan = payload.Plan
	for _, name := range []string{"premium_interactions", "chat", "completions"} {
		v, ok := payload.Quotas[name]
		if !ok {
			continue
		}
		w := QuotaWindow{Name: strings.ReplaceAll(name, "_", " "), ResetsAt: quotaReset(payload.Reset), Unlimited: v.Unlimited}
		if !v.Unlimited {
			if v.Remaining == nil || (v.Entitlement != nil && *v.Entitlement == 0) {
				continue
			}
			w.UsedPercent = 100 - *v.Remaining
		}
		q.Windows = append(q.Windows, w)
	}
	return finishQuota(q, now)
}
