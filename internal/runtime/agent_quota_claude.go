package runtime

import (
	"context"
	"encoding/json"
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

// Security.framework is called with interaction forbidden: a phone refresh
// must not open a Keychain password/permission dialog on the unattended Mac.
const quotaKeychainScript = `ObjC.import('Security');
function run(argv) {
 const q = $.NSMutableDictionary.alloc.init;
 q.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);
 q.setObjectForKey($(argv[0]), $.kSecAttrService);
 q.setObjectForKey($.kCFBooleanTrue, $.kSecReturnData);
 q.setObjectForKey($.kSecMatchLimitOne, $.kSecMatchLimit);
 q.setObjectForKey($.kSecUseAuthenticationUIFail, $.kSecUseAuthenticationUI);
 const result = Ref();
 const status = $.SecItemCopyMatching(q, result);
 if (status !== 0) return '';
 return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding));
}`

func claudeQuotaCredentials(ctx context.Context) (claudeQuotaAuth, string) {
	var auth claudeQuotaAuth
	path, err := ClaudeQuotaPath()
	if err != nil {
		return auth, "unavailable"
	}
	raw, err := quotaFile(filepath.Join(filepath.Dir(path), ".credentials.json"), 1024*1024)
	if os.IsNotExist(err) && goruntime.GOOS == "darwin" && os.Getenv("CLAUDE_CONFIG_DIR") == "" {
		raw, err = quotaCommand(ctx, 1024*1024, "/usr/bin/osascript", "-l", "JavaScript", "-e", quotaKeychainScript, "Claude Code-credentials")
	}
	if err != nil || len(raw) == 0 || json.Unmarshal(raw, &auth) != nil {
		return auth, "auth_required"
	}
	if auth.OAuth.AccessToken == "" || len(auth.OAuth.AccessToken) > 16384 {
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
		if !found {
			return auth, "auth_required"
		}
	}
	return auth, ""
}
func readClaudeAutoQuota(ctx context.Context) AgentQuota {
	if os.Getenv("PAIRFOB_CLAUDE_QUOTA_SOURCE") == "statusline" {
		return readClaudeQuota(time.Now())
	}
	q := emptyQuota("claude", "oauth", "unavailable")
	auth, status := claudeQuotaCredentials(ctx)
	if status != "" {
		q.Status = status
		return q
	}
	return fetchClaudeQuota(ctx, quotaHTTPClient(), auth, time.Now())
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
		q.Windows = append(q.Windows, QuotaWindow{Name: strings.ReplaceAll(name, "_", " "), UsedPercent: *w.Used, WindowMinutes: minutes, ResetsAt: quotaReset(w.Reset)})
	}
	return finishQuota(q, now)
}
