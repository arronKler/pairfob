package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Only the current local subscription credential is read; no refresh or CLI
// startup is needed. Ambiguous accounts and team principals fail closed.
func grokQuotaToken(now time.Time) (string, string) {
	dir := os.Getenv("GROK_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "auth_required"
		}
		dir = filepath.Join(home, ".grok")
	}
	raw, err := quotaFile(filepath.Join(dir, "auth.json"), 1024*1024)
	if err != nil {
		return "", "auth_required"
	}
	var entries map[string]struct {
		Key       string `json:"key"`
		Expires   string `json:"expires_at"`
		Principal string `json:"principal_type"`
	}
	if json.Unmarshal(raw, &entries) != nil {
		return "", "auth_required"
	}
	token, principal := "", ""
	count := 0
	for issuer, entry := range entries {
		if !strings.HasPrefix(issuer, "https://auth.x.ai::") {
			continue
		}
		count++
		if count > 1 {
			return "", "auth_required"
		}
		expires, err := time.Parse(time.RFC3339Nano, entry.Expires)
		if err != nil || !expires.After(now.Add(time.Minute)) || entry.Key == "" || len(entry.Key) > 16384 || strings.HasPrefix(entry.Key, "xai-") {
			return "", "auth_required"
		}
		token, principal = entry.Key, entry.Principal
	}
	if token == "" {
		return "", "auth_required"
	}
	if principal != "User" {
		return "", "unsupported"
	}
	return token, ""
}
func readGrokQuota(ctx context.Context) AgentQuota {
	token, status := grokQuotaToken(time.Now())
	if status != "" {
		return emptyQuota("grok", "oauth", status)
	}
	return fetchGrokQuota(ctx, quotaHTTPClient(), token, time.Now())
}
func fetchGrokQuota(ctx context.Context, client *http.Client, token string, now time.Time) AgentQuota {
	headers := map[string]string{"Authorization": "Bearer " + token, "x-xai-token-auth": "xai-grok-cli"}
	var raw json.RawMessage
	var settings struct {
		Plan string `json:"subscription_tier_display"`
	}
	var status string
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		status = quotaJSON(ctx, client, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, nil, &raw)
	}()
	go func() {
		defer wg.Done()
		short, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		_ = quotaJSON(short, client, "https://cli-chat-proxy.grok.com/v1/settings", headers, nil, &settings)
	}()
	wg.Wait()
	if status != "" {
		return emptyQuota("grok", "oauth", status)
	}
	q := parseGrokQuota(raw, now)
	if len(settings.Plan) <= 80 {
		q.Plan = settings.Plan
	}
	return q
}
func parseGrokQuota(raw []byte, now time.Time) AgentQuota {
	q := emptyQuota("grok", "oauth", "unavailable")
	var payload struct {
		Config *struct {
			Percent *float64 `json:"creditUsagePercent"`
			Period  *struct {
				Type string `json:"type"`
				End  string `json:"end"`
			} `json:"currentPeriod"`
			End string `json:"billingPeriodEnd"`
		} `json:"config"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Config == nil || payload.Config.Percent == nil {
		return q
	}
	c := payload.Config
	w := QuotaWindow{Name: "Shared subscription quota", UsedPercent: *c.Percent, ResetsAt: quotaReset(c.End)}
	if c.Period != nil {
		w.ResetsAt = quotaReset(c.Period.End)
		if c.Period.Type == "USAGE_PERIOD_TYPE_WEEKLY" {
			w.WindowMinutes = 10080
		}
	}
	// On-demand spending is deliberately not used to infer subscription allowance.
	q.Windows = append(q.Windows, w)
	return finishQuota(q, now)
}
