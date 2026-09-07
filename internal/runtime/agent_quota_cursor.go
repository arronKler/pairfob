package runtime

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"
	"unicode/utf16"
)

func cursorQuotaToken(ctx context.Context) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		dir = filepath.Join(home, ".config")
	}
	if goruntime.GOOS == "darwin" {
		dir = filepath.Join(home, "Library", "Application Support")
	}
	path := filepath.Join(dir, "Cursor", "User", "globalStorage", "state.vscdb")
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() {
		return ""
	}
	uri := url.URL{Scheme: "file", Path: path}
	params := url.Values{"mode": {"ro"}}
	if _, err := os.Stat(path + "-wal"); os.IsNotExist(err) {
		params.Set("immutable", "1")
	}
	uri.RawQuery = params.Encode()
	raw, err := quotaCommand(ctx, 65536, "sqlite3", "-readonly", uri.String(), "SELECT hex(value) FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;")
	if err != nil {
		return ""
	}
	data, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return ""
	}
	if len(data) > 1 && (data[1] == 0 || (data[0] == 0xff && data[1] == 0xfe)) {
		if data[0] == 0xff && data[1] == 0xfe {
			data = data[2:]
		}
		if len(data)%2 != 0 {
			return ""
		}
		words := make([]uint16, len(data)/2)
		for i := range words {
			words[i] = uint16(data[2*i]) | uint16(data[2*i+1])<<8
		}
		return string(utf16.Decode(words))
	}
	return string(data)
}
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
	cookie := cursorQuotaCookie(cursorQuotaToken(ctx), time.Now())
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
