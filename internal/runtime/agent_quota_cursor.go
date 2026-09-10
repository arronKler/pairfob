package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func cursorQuotaCookie(token string, now time.Time) string {
	if len(token) > 16384 {
		return ""
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Exp <= now.Unix()+60 {
		return ""
	}
	ids := strings.Split(claims.Sub, "|")
	id := ids[len(ids)-1]
	if len(id) == 0 || len(id) > 256 {
		return ""
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r)) {
			return ""
		}
	}
	return "WorkosCursorSessionToken=" + url.QueryEscape(id+"::"+token)
}
func readCursorQuota(ctx context.Context) AgentQuota {
	token, status := cursorQuotaToken(ctx)
	if status != "" {
		return emptyQuota("cursor", "web_api", status)
	}
	cookie := cursorQuotaCookie(token, time.Now())
	if cookie == "" {
		return emptyQuota("cursor", "web_api", "auth_required")
	}
	return fetchCursorQuota(ctx, quotaHTTPClient(), cookie, time.Now())
}
func fetchCursorQuota(ctx context.Context, c *http.Client, cookie string, now time.Time) AgentQuota {
	q := emptyQuota("cursor", "web_api", "unavailable")
	var raw json.RawMessage
	status := quotaJSON(ctx, c, "https://cursor.com/api/usage-summary", map[string]string{"Cookie": cookie}, nil, &raw)
	if status != "" {
		q.Status = status
		return q
	}
	return parseCursorQuota(raw, now)
}
func parseCursorQuota(raw []byte, now time.Time) AgentQuota {
	q := emptyQuota("cursor", "web_api", "unavailable")
	var payload struct {
		Plan       string `json:"membershipType"`
		End        string `json:"billingCycleEnd"`
		Unlimited  bool   `json:"isUnlimited"`
		Individual struct {
			Plan *struct {
				Enabled *bool    `json:"enabled"`
				Percent *float64 `json:"totalPercentUsed"`
				Used    *float64 `json:"used"`
				Limit   *float64 `json:"limit"`
			} `json:"plan"`
		} `json:"individualUsage"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return q
	}
	q.Plan = payload.Plan
	w := QuotaWindow{Name: "Included plan", ResetsAt: quotaReset(payload.End), Unlimited: payload.Unlimited}
	if !payload.Unlimited {
		plan := payload.Individual.Plan
		if plan == nil || (plan.Enabled != nil && !*plan.Enabled) {
			return q
		}
		if plan.Percent != nil {
			w.UsedPercent = *plan.Percent
		} else if plan.Used != nil && plan.Limit != nil && *plan.Limit > 0 {
			w.UsedPercent = *plan.Used / *plan.Limit * 100
		} else {
			return q
		}
		// Overages cannot create negative remaining subscription allowance.
		w.UsedPercent = math.Min(100, w.UsedPercent)
	}
	q.Windows = append(q.Windows, w)
	return finishQuota(q, now)
}
