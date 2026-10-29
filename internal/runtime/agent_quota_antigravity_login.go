package runtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	goruntime "runtime"
	"strings"
	"time"
)

// The Antigravity CLI answers its loopback port only to commands it started
// itself, so its allowance is read the way the CLI reads it: from Google's
// Code Assist API, with the login the CLI keeps in the system keyring. The
// access token there lasts an hour and only the CLI renews it.

const antigravityCodeAssist = "https://cloudcode-pa.googleapis.com/v1internal:"

// antigravityStoredLogin returns the CLI's access token, or why there is none
// to use. "" as the status with no token means no login is stored at all.
func antigravityStoredLogin(ctx context.Context, now time.Time) (token, status string) {
	if goruntime.GOOS != "darwin" {
		return "", ""
	}
	raw, err := quotaKeychainRead(ctx, "gemini", "antigravity", 256*1024)
	if errors.Is(err, errQuotaKeychainNotFound) {
		return "", ""
	}
	if err != nil {
		return "", quotaKeychainStatus(err)
	}
	return parseAntigravityLogin(raw, now)
}

// The keyring library wraps a value that is not plain text.
func antigravityKeyringValue(raw []byte) []byte {
	text := string(bytes.TrimSpace(raw))
	if rest, ok := strings.CutPrefix(text, "go-keyring-base64:"); ok {
		out, err := base64.StdEncoding.DecodeString(rest)
		if err != nil {
			return nil
		}
		return out
	}
	if rest, ok := strings.CutPrefix(text, "go-keyring-encoded:"); ok {
		out, err := hex.DecodeString(rest)
		if err != nil {
			return nil
		}
		return out
	}
	return []byte(text)
}

// parseAntigravityLogin finds the access token and its expiry in a stored
// login. The CLI's storage format is its own and unversioned, so the token is
// looked for by name, at the top or one object down. A login whose shape is
// not recognized is a read that failed, not a login to renew; one with no
// readable expiry is left for the API to judge.
func parseAntigravityLogin(raw []byte, now time.Time) (token, status string) {
	var top map[string]json.RawMessage
	if json.Unmarshal(antigravityKeyringValue(raw), &top) != nil {
		return "", "unavailable"
	}
	objects := []map[string]json.RawMessage{top}
	for _, value := range top {
		var text string
		if json.Unmarshal(value, &text) == nil {
			value = json.RawMessage(text)
		}
		var inner map[string]json.RawMessage
		if json.Unmarshal(value, &inner) == nil && inner != nil {
			objects = append(objects, inner)
		}
	}
	for _, object := range objects {
		var expiry time.Time
		for key, value := range object {
			switch strings.ReplaceAll(strings.ToLower(key), "_", "") {
			case "accesstoken":
				_ = json.Unmarshal(value, &token)
			case "expiry", "expiresat", "expirydate":
				expiry = antigravityExpiry(value)
			}
		}
		if token == "" {
			continue
		}
		if len(token) > 16384 {
			return "", "unavailable"
		}
		if !expiry.IsZero() && !expiry.After(now.Add(time.Minute)) {
			return "", "auth_required"
		}
		return token, ""
	}
	return "", "unavailable"
}

// An expiry is a timestamp, or Unix seconds or milliseconds.
func antigravityExpiry(raw json.RawMessage) time.Time {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		at, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			return time.Time{}
		}
		return at
	}
	var number float64
	if json.Unmarshal(raw, &number) != nil || number <= 0 {
		return time.Time{}
	}
	if number > 1e11 {
		return time.UnixMilli(int64(number))
	}
	return time.Unix(int64(number), 0)
}

// fetchAntigravityCloudQuota asks for the account's tier and project, then for
// its quota summary. Neither request starts a model turn or renews the login.
func fetchAntigravityCloudQuota(ctx context.Context, c *http.Client, base, token string, now time.Time) AgentQuota {
	failed := func(status string) AgentQuota {
		// Google answers an expired token with 401. A 403 is about the account
		// or where the request came from, which signing in again does not change.
		if status == "auth_required" && quotaForbidden(ctx) {
			status = "unavailable"
		}
		return emptyQuota("antigravity", "oauth", status)
	}
	headers := map[string]string{"Authorization": "Bearer " + token}
	var assist struct {
		Project json.RawMessage `json:"cloudaicompanionProject"`
		Current *struct {
			Name string `json:"name"`
		} `json:"currentTier"`
		Paid *struct {
			Name string `json:"name"`
		} `json:"paidTier"`
	}
	status := quotaJSON(ctx, c, base+"loadCodeAssist", headers, []byte(`{"metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}`), &assist)
	if status != "" {
		return failed(status)
	}
	request := map[string]string{}
	if project := antigravityProject(assist.Project); project != "" {
		request["project"] = project
	}
	body, _ := json.Marshal(request)
	var raw json.RawMessage
	if status := quotaJSON(ctx, c, base+"retrieveUserQuotaSummary", headers, body, &raw); status != "" {
		return failed(status)
	}
	q := parseAntigravityQuota(raw, now)
	q.Source = "oauth"
	if assist.Paid != nil && assist.Paid.Name != "" {
		q.Plan = assist.Paid.Name
	} else if assist.Current != nil {
		q.Plan = assist.Current.Name
	}
	if len(q.Plan) > 80 {
		q.Plan = ""
	}
	return q
}

// The project comes back as its ID, or as an object that carries the ID.
func antigravityProject(raw json.RawMessage) string {
	var id string
	if json.Unmarshal(raw, &id) != nil {
		var object struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &object) != nil {
			return ""
		}
		id = object.ID
	}
	if len(id) > 128 {
		return ""
	}
	return id
}
