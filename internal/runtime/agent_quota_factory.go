package runtime

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Factory (the droid CLI) reports its subscription allowance through the
// billing route the CLI itself calls. The login is stored encrypted: the CLI
// keeps an AES-256-GCM key in the login keychain and the ciphertext in
// ~/.factory. This read decrypts it in memory, uses the access token for one
// GET, and never writes, refreshes or logs a credential.
const factoryBillingURL = "https://api.factory.ai/api/billing/limits"

// factoryKeychain is the CLI's own keychain item. The account name differs
// between the two storage layouts the CLI has shipped.
var factoryKeychainAccounts = []string{"auth-encryption-key-security-cli", "auth-encryption-key"}

// factoryCredentialFiles are the encrypted stores, newest layout first.
var factoryCredentialFiles = []string{"auth.v2.loginkeychain", "auth.v2.keyring"}

func locateFactoryQuota(context.Context) (quotaAccountRead, AgentQuota) {
	dir, status := factoryConfigDir()
	if status != "" {
		return nil, emptyQuota("factory", "api", status)
	}
	if !factoryHasLogin(dir) {
		return nil, emptyQuota("factory", "api", "not_logged_in")
	}
	return func(ctx context.Context) QuotaAccount {
		return fetchFactoryQuota(ctx, quotaHTTPClient(), dir, time.Now())
	}, AgentQuota{}
}

// factoryConfigDir is the CLI's own directory. FACTORY_HOME moves it, as the
// CLI itself allows.
func factoryConfigDir() (string, string) {
	dir := strings.TrimSpace(os.Getenv("FACTORY_HOME"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", "not_installed"
		}
		dir = filepath.Join(home, ".factory")
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", "not_installed"
	}
	return dir, ""
}

// factoryHasLogin looks for an encrypted store before any request, so a
// computer that never ran the CLI reports no login rather than a failure.
func factoryHasLogin(dir string) bool {
	for _, name := range factoryCredentialFiles {
		if info, err := os.Lstat(filepath.Join(dir, name)); err == nil && info.Mode().IsRegular() {
			return true
		}
	}
	return false
}

func fetchFactoryQuota(ctx context.Context, c *http.Client, dir string, now time.Time) QuotaAccount {
	creds, status := factoryCredentials(ctx, dir)
	if status != "" {
		return quotaAccount(emptyQuota("factory", "api", status))
	}
	raw, status := factoryBilling(ctx, c, creds)
	if status != "" {
		return quotaAccount(emptyQuota("factory", "api", status))
	}
	return parseFactoryQuota(raw, now)
}

// factoryCredentials decrypts the stored login. The key comes from the login
// keychain through the same native reader the other providers use, so a
// background read never prompts and a denied read is a state, not a crash.
func factoryCredentials(ctx context.Context, dir string) (factoryLogin, string) {
	var ciphertext []byte
	for _, name := range factoryCredentialFiles {
		raw, err := quotaFile(filepath.Join(dir, name), 64*1024)
		if err == nil {
			ciphertext = raw
			break
		}
	}
	if ciphertext == nil {
		return factoryLogin{}, "not_logged_in"
	}
	key, status := factoryKey(ctx)
	if status != "" {
		return factoryLogin{}, status
	}
	defer clear(key)
	plain, err := factoryDecrypt(string(ciphertext), key)
	if err != nil {
		return factoryLogin{}, "auth_required"
	}
	defer clear(plain)
	var login factoryLogin
	if json.Unmarshal(plain, &login) != nil || !validQuotaKey(login.AccessToken) {
		return factoryLogin{}, "auth_required"
	}
	return login, ""
}

// factoryKey reads the CLI's encryption key. It is a base64 32-byte value in
// the login keychain; a missing item is a login this build cannot open.
func factoryKey(ctx context.Context) ([]byte, string) {
	for _, account := range factoryKeychainAccounts {
		raw, err := quotaKeychainReadAs(ctx, "factory", "Factory CLI", account, 4096)
		if err != nil {
			if errors.Is(err, errQuotaKeychainNotFound) {
				continue
			}
			if errors.Is(err, errQuotaKeychainInteraction) || errors.Is(err, errQuotaKeychainCancelled) {
				return nil, "keychain_denied"
			}
			return nil, "unavailable"
		}
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		clear(raw)
		if err != nil || len(key) != 32 {
			clear(key)
			continue
		}
		return key, ""
	}
	return nil, "auth_required"
}

// factoryDecrypt opens the CLI's `iv:tag:ciphertext` envelope. The CLI uses a
// 16-byte nonce, so the standard 12-byte GCM nonce size does not apply.
func factoryDecrypt(raw string, key []byte) ([]byte, error) {
	parts := strings.Split(strings.TrimSpace(raw), ":")
	if len(parts) != 3 {
		return nil, errors.New("unexpected credential envelope")
	}
	iv, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil || len(iv) == 0 || len(iv) > 32 {
		return nil, errors.New("unexpected credential nonce")
	}
	tag, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || len(tag) != 16 {
		return nil, errors.New("unexpected credential tag")
	}
	body, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil || len(body) == 0 || len(body) > 64*1024 {
		return nil, errors.New("unexpected credential body")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, iv, append(body, tag...), nil)
}

// factoryLogin is the part of the stored credential this read needs.
type factoryLogin struct {
	AccessToken string `json:"access_token"`
	OrgID       string `json:"active_organization_id"`
}

// factoryBilling asks for the account's limits. 401 is a login to renew; 403 is
// an authenticated account the billing route does not serve.
func factoryBilling(ctx context.Context, c *http.Client, login factoryLogin) ([]byte, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, factoryBillingURL, nil)
	if err != nil {
		return nil, "unavailable"
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+login.AccessToken)
	if login.OrgID != "" && len(login.OrgID) <= 128 {
		req.Header.Set("X-Factory-Org-Id", login.OrgID)
	}
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

// parseFactoryQuota keeps the standard allowance's windows. A plan without a
// subscription has no limits to show, which is not zero usage.
func parseFactoryQuota(raw []byte, now time.Time) QuotaAccount {
	var payload struct {
		Active *bool `json:"hasActiveSubscription"`
		Limits struct {
			Standard *struct {
				FiveHour *factoryWindow `json:"fiveHour"`
				Weekly   *factoryWindow `json:"weekly"`
				Monthly  *factoryWindow `json:"monthly"`
			} `json:"standard"`
		} `json:"limits"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return quotaAccount(emptyQuota("factory", "api", "unavailable"))
	}
	if payload.Active != nil && !*payload.Active {
		// The login is real; the account behind it has no subscription
		// allowance. That is not a login to renew, and never zero usage.
		return quotaAccount(emptyQuota("factory", "api", "unsupported"))
	}
	standard := payload.Limits.Standard
	if standard == nil {
		return quotaAccount(emptyQuota("factory", "api", "unavailable"))
	}
	a := QuotaAccount{ID: "factory", Provider: "factory", Source: "api", State: "ok", ObservedAt: now.Unix(), Meters: []QuotaMeter{}}
	for _, spec := range []struct {
		name    string
		minutes int64
		window  *factoryWindow
	}{
		{"five hour", 300, standard.FiveHour},
		{"seven day", 10080, standard.Weekly},
		{"monthly", 0, standard.Monthly},
	} {
		w := spec.window
		if w == nil || w.UsedPercent == nil {
			continue
		}
		used := *w.UsedPercent
		if used < 0 || used > 100 {
			return quotaAccount(emptyQuota("factory", "api", "unavailable"))
		}
		m := QuotaMeter{
			Kind: "quota", Name: spec.name, Pool: "plan", Headline: true,
			UsedPercent: &used, WindowMinutes: spec.minutes, ResetsAt: quotaReset(w.WindowEnd),
		}
		if !validQuotaMeter(m) {
			return quotaAccount(emptyQuota("factory", "api", "unavailable"))
		}
		a.Meters = append(a.Meters, m)
	}
	if len(a.Meters) == 0 {
		return quotaAccount(emptyQuota("factory", "api", "unavailable"))
	}
	return finishQuotaAccount(a)
}

// factoryWindow is one allowance window of the billing document.
type factoryWindow struct {
	UsedPercent *float64 `json:"usedPercent"`
	WindowEnd   string   `json:"windowEnd"`
}
