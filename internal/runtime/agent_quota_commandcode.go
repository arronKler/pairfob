package runtime

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Command Code meters a subscription in two rate-limit windows and a monthly
// credit balance. The alpha API takes the same `user_...` key the `cmd` CLI
// uses; every call is a read-only GET, so polling spends no credits. No CLI
// process, model turn or credential write happens.
const commandCodeAPIURL = "https://api.commandcode.ai"

func locateCommandCodeQuota(context.Context) (quotaAccountRead, AgentQuota) {
	key, status := commandCodeKey()
	if status != "" {
		return nil, emptyQuota("command-code", "api", status)
	}
	return func(ctx context.Context) QuotaAccount {
		return fetchCommandCodeQuota(ctx, quotaHTTPClient(), key, time.Now())
	}, AgentQuota{}
}

// commandCodeKey prefers a variable, then the login the `command-code` CLI
// writes itself, then a key file for a computer that never ran the CLI.
func commandCodeKey() (string, string) {
	if value, ok := quotaEnvKey("COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"); ok {
		if validQuotaKey(value) {
			return value, ""
		}
		return "", "not_logged_in"
	}
	if key, status := commandCodeLogin(); status == "" {
		return key, ""
	}
	path, err := quotaStatePath("command-code.key")
	if err != nil {
		return "", "not_logged_in"
	}
	return quotaKeyFile(path)
}

// commandCodeLogin reads ~/.commandcode/auth.json, where the CLI keeps the key
// `command-code login` stored. Only the key is read; the same file holds the
// user's name and other provider keys, and none of it is copied anywhere.
func commandCodeLogin() (string, string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "not_logged_in"
	}
	raw, err := quotaFile(filepath.Join(home, ".commandcode", "auth.json"), quotaKeyFileLimit)
	if err != nil {
		return "", "not_logged_in"
	}
	var doc struct {
		APIKey string `json:"apiKey"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return "", "not_logged_in"
	}
	key := strings.TrimSpace(doc.APIKey)
	if !validQuotaKey(key) {
		return "", "not_logged_in"
	}
	return key, ""
}

// fetchCommandCodeQuota asks who the key belongs to, then the billing numbers.
// whoami supplies the organisation every billing lookup is scoped to. Credits
// carry the numbers to show; subscriptions name the plan and when the month
// turns over, so losing only that costs the plan line rather than the read.
func fetchCommandCodeQuota(ctx context.Context, c *http.Client, key string, now time.Time) QuotaAccount {
	headers := map[string]string{"Authorization": "Bearer " + key, "User-Agent": "pairfob"}
	var whoami struct {
		Org *struct {
			ID string `json:"id"`
		} `json:"org"`
	}
	if status := quotaJSON(ctx, c, commandCodeAPIURL+"/alpha/whoami", headers, nil, &whoami); status != "" {
		return quotaAccount(emptyQuota("command-code", "api", status))
	}
	query := ""
	if whoami.Org != nil && strings.TrimSpace(whoami.Org.ID) != "" {
		query = "?orgId=" + url.QueryEscape(strings.TrimSpace(whoami.Org.ID))
	}
	var credits commandCodeCredits
	if status := quotaJSON(ctx, c, commandCodeAPIURL+"/alpha/billing/credits"+query, headers, nil, &credits); status != "" {
		return quotaAccount(emptyQuota("command-code", "api", status))
	}
	var plan string
	var periodEnd int64
	var subscription commandCodeSubscription
	switch status := quotaJSON(ctx, c, commandCodeAPIURL+"/alpha/billing/subscriptions"+query, headers, nil, &subscription); status {
	case "":
		if subscription.Data != nil {
			plan, periodEnd = commandCodePlan(subscription.Data.PlanID), subscription.Data.CurrentPeriodEnd.unix()
		}
	case "auth_required", "throttled":
		return quotaAccount(emptyQuota("command-code", "api", status))
	}
	return parseCommandCodeQuota(credits, plan, periodEnd, now)
}

// parseCommandCodeQuota builds one meter per rate-limit window and a balance
// for the credits left this month. A window that is present must carry both
// numbers: a half-read window is a format change, not zero usage.
func parseCommandCodeQuota(c commandCodeCredits, plan string, periodEnd int64, now time.Time) QuotaAccount {
	if c.Credits == nil || c.Credits.Monthly == nil {
		return quotaAccount(emptyQuota("command-code", "api", "unavailable"))
	}
	a := QuotaAccount{ID: "command-code", Provider: "command-code", Plan: plan, Source: "api", State: "ok", ObservedAt: now.Unix(), Meters: []QuotaMeter{}}
	var fiveHour, weekly *commandCodeWindow
	if c.WindowLimits != nil {
		fiveHour, weekly = c.WindowLimits.FiveHour, c.WindowLimits.Weekly
	}
	for _, window := range []struct {
		name    string
		minutes int64
		limit   *commandCodeWindow
	}{
		{name: "five hour", minutes: 300, limit: fiveHour},
		{name: "seven day", minutes: 10080, limit: weekly},
	} {
		w := window.limit
		if w == nil {
			continue
		}
		if w.Used == nil || w.Cap == nil {
			return quotaAccount(emptyQuota("command-code", "api", "unavailable"))
		}
		used, limit := float64(*w.Used), float64(*w.Cap)
		if !commandCodeNumber(used) || !commandCodeNumber(limit) || used < 0 {
			return quotaAccount(emptyQuota("command-code", "api", "unavailable"))
		}
		// A plan that sets no cap on this window has no share to show.
		if limit <= 0 {
			continue
		}
		a.Meters = append(a.Meters, commandCodeShare(window.name, window.minutes, used, limit, w.ResetAt.unix()))
	}
	remaining := float64(*c.Credits.Monthly)
	for _, extra := range []*quotaFlexNumber{c.Credits.Purchased, c.Credits.Free} {
		if extra != nil {
			remaining += float64(*extra)
		}
	}
	amount, ok := commandCodeCents(remaining)
	if !ok {
		return quotaAccount(emptyQuota("command-code", "api", "unavailable"))
	}
	a.Meters = append(a.Meters, QuotaMeter{
		Kind: "balance", Name: "monthly balance", Pool: "usd", Headline: true,
		Amount: &amount, Scale: 2, Unit: "usd", ResetsAt: periodEnd,
	})
	return finishQuotaAccount(a)
}

// commandCodeShare turns one rate-limit window into a used share. The windows
// are denominated in dollars of usage, so the counts behind the share are
// dollars as well; a number too large to be a count is left out rather than
// rounded into a different one.
func commandCodeShare(name string, minutes int64, used, limit float64, reset int64) QuotaMeter {
	percent := min(math.Round(used/limit*1000)/10, 100)
	m := QuotaMeter{
		Kind: "quota", Name: name, Pool: "plan", Headline: true,
		UsedPercent: &percent, WindowMinutes: minutes, ResetsAt: reset,
	}
	usedCents, usedOK := commandCodeCents(used)
	limitCents, limitOK := commandCodeCents(limit)
	if usedOK && limitOK && limitCents > 0 {
		m.Used, m.Limit, m.Scale, m.Unit = &usedCents, &limitCents, 2, "usd"
	}
	return m
}

// commandCodeCents reads a dollar amount as cents. A number that cannot be a
// count is refused rather than rounded into a different one.
func commandCodeCents(v float64) (int64, bool) {
	if !commandCodeNumber(v) {
		return 0, false
	}
	cents := math.Round(v * 100)
	if cents < 0 || cents > float64(quotaMaxCount) {
		return 0, false
	}
	return int64(cents), true
}

func commandCodeNumber(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// commandCodePlan turns a plan id such as "individual-goat" into the label a
// card shows. An id with anything but letters, digits and separators is not
// shown at all.
func commandCodePlan(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 64 {
		return ""
	}
	for _, r := range raw {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return ""
		}
	}
	words := strings.FieldsFunc(raw, func(r rune) bool { return r == '-' || r == '_' || r == '.' })
	for i, word := range words {
		words[i] = strings.ToUpper(word[:1]) + word[1:]
	}
	return strings.Join(words, " ")
}

type commandCodeCredits struct {
	Credits *struct {
		Monthly   *quotaFlexNumber `json:"monthlyCredits"`
		Purchased *quotaFlexNumber `json:"purchasedCredits"`
		Free      *quotaFlexNumber `json:"freeCredits"`
	} `json:"credits"`
	WindowLimits *struct {
		FiveHour *commandCodeWindow `json:"fiveHour"`
		Weekly   *commandCodeWindow `json:"weekly"`
	} `json:"windowLimits"`
}

type commandCodeSubscription struct {
	Data *struct {
		PlanID           string        `json:"planId"`
		CurrentPeriodEnd quotaFlexTime `json:"currentPeriodEnd"`
	} `json:"data"`
}

// commandCodeWindow is one rate-limit window. Both numbers and the reset are
// optional on the wire so a half-read window can be refused instead of shown.
type commandCodeWindow struct {
	Used    *quotaFlexNumber `json:"used"`
	Cap     *quotaFlexNumber `json:"cap"`
	ResetAt *quotaFlexTime   `json:"resetAt"`
}

// quotaFlexNumber accepts a JSON number, or a numeric string with a dollar
// sign and thousands separators, which the alpha API has sent both ways.
type quotaFlexNumber float64

func (n *quotaFlexNumber) UnmarshalJSON(b []byte) error {
	raw := strings.TrimSpace(string(b))
	if strings.HasPrefix(raw, `"`) {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(str), "$"))
		raw = strings.ReplaceAll(raw, ",", "")
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return err
	}
	*n = quotaFlexNumber(v)
	return nil
}

// quotaFlexTime accepts epoch seconds, epoch milliseconds or an RFC3339
// timestamp. Anything else, or a value outside the wire's range, is no reset.
type quotaFlexTime struct {
	at int64
}

func (t *quotaFlexTime) UnmarshalJSON(b []byte) error {
	raw := strings.TrimSpace(string(b))
	if strings.HasPrefix(raw, `"`) {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		raw = strings.TrimSpace(str)
	}
	if raw == "" || raw == "null" {
		return nil
	}
	if isDigits(raw) {
		seconds, err := strconv.ParseFloat(raw, 64)
		if err != nil || seconds <= 0 || seconds > 1e13 {
			return nil
		}
		if seconds >= 1e12 {
			seconds /= 1000
		}
		if seconds <= float64(quotaMaxTime) {
			t.at = int64(seconds)
		}
		return nil
	}
	t.at = quotaReset(raw)
	return nil
}

func (t *quotaFlexTime) unix() int64 {
	if t == nil {
		return 0
	}
	return t.at
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
