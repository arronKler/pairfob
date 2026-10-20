package runtime

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AgentQuota is an account-level snapshot, never a sum of pane token usage.
// Empty plan means the provider did not identify the subscription tier.
type AgentQuota struct {
	Provider   string        `json:"provider"`
	Plan       string        `json:"plan"`
	Status     string        `json:"status"`
	Source     string        `json:"source"`
	ObservedAt int64         `json:"observed_at"`
	Windows    []QuotaWindow `json:"windows"`
}

type QuotaWindow struct {
	Unlimited     bool    `json:"unlimited,omitempty"`
	Name          string  `json:"name"`
	UsedPercent   float64 `json:"used_percent"`
	WindowMinutes int64   `json:"window_minutes"`
	ResetsAt      int64   `json:"resets_at"`

	// How AgentQuotaV2 groups this window (see QuotaMeter). The first
	// AgentQuota wire has neither; an unmarked window is its plan's own.
	pool     string
	headline bool
}

func emptyQuota(provider, source, status string) AgentQuota {
	return AgentQuota{Provider: provider, Source: source, Status: status, Windows: []QuotaWindow{}}
}

func validQuotaWindow(w QuotaWindow) bool {
	return (!w.Unlimited || w.UsedPercent == 0) && w.Name != "" && len(w.Name) <= 160 && !math.IsNaN(w.UsedPercent) && !math.IsInf(w.UsedPercent, 0) && w.UsedPercent >= 0 && w.UsedPercent <= 100 && w.WindowMinutes >= 0 && w.WindowMinutes <= 525600 && w.ResetsAt >= 0 && w.ResetsAt <= 4102444800
}

// ClaudeQuotaPath is shared with the statusline collector. No credentials,
// prompts, cwd, or transcript content are persisted here.
func ClaudeQuotaPath() (string, error) {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".claude")
	}
	return filepath.Join(dir, "pairfob-quota.json"), nil
}

func readClaudeQuota(now time.Time) AgentQuota {
	q := emptyQuota("claude", "statusline", "setup_required")
	path, err := ClaudeQuotaPath()
	if err != nil {
		q.Status = "unavailable"
		return q
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return q
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		q.Status = "unavailable"
		return q
	}
	f, err := os.Open(path)
	if err != nil {
		q.Status = "unavailable"
		return q
	}
	defer f.Close()
	if err := json.NewDecoder(io.LimitReader(f, 16384)).Decode(&q); err != nil {
		return emptyQuota("claude", "statusline", "unavailable")
	}
	if q.Provider != "claude" || q.Source != "statusline" || q.Plan != "" || len(q.Windows) > 3 || q.ObservedAt <= 0 || q.ObservedAt > now.Unix()+60 || (q.Status != "ok" && q.Status != "unavailable") {
		return emptyQuota("claude", "statusline", "unavailable")
	}
	for _, w := range q.Windows {
		if !validQuotaWindow(w) {
			return emptyQuota("claude", "statusline", "unavailable")
		}
	}
	if len(q.Windows) == 0 {
		q.Windows = []QuotaWindow{}
		q.Status = "unavailable"
		return q
	}
	for i := range q.Windows {
		markClaudeWindow(&q.Windows[i])
	}
	if now.Unix()-q.ObservedAt > 900 {
		q.Status = "stale"
	}
	for _, w := range q.Windows {
		if w.ResetsAt <= now.Unix() {
			q.Status = "stale"
		}
	}
	return q
}

// AntigravityQuotaPath is shared with the statusline collector. No credentials,
// prompts, cwd, or transcript content are persisted here.
func AntigravityQuotaPath() (string, error) {
	dir := os.Getenv("ANTIGRAVITY_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".gemini", "antigravity-cli")
	}
	return filepath.Join(dir, "pairfob-quota.json"), nil
}

func readAntigravityStatuslineQuota(now time.Time) AgentQuota {
	q := emptyQuota("antigravity", "statusline", "setup_required")
	path, err := AntigravityQuotaPath()
	if err != nil {
		q.Status = "unavailable"
		return q
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return q
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		q.Status = "unavailable"
		return q
	}
	f, err := os.Open(path)
	if err != nil {
		q.Status = "unavailable"
		return q
	}
	defer f.Close()
	if err := json.NewDecoder(io.LimitReader(f, 16384)).Decode(&q); err != nil {
		return emptyQuota("antigravity", "statusline", "unavailable")
	}
	if q.Provider != "antigravity" || q.Source != "statusline" || len(q.Windows) > 8 || q.ObservedAt <= 0 || q.ObservedAt > now.Unix()+60 || (q.Status != "ok" && q.Status != "unavailable") {
		return emptyQuota("antigravity", "statusline", "unavailable")
	}
	for _, w := range q.Windows {
		if !validQuotaWindow(w) {
			return emptyQuota("antigravity", "statusline", "unavailable")
		}
	}
	if len(q.Windows) == 0 {
		q.Windows = []QuotaWindow{}
		q.Status = "unavailable"
		return q
	}
	for i := range q.Windows {
		markAntigravityWindow(&q.Windows[i])
	}
	if now.Unix()-q.ObservedAt > 900 {
		q.Status = "stale"
	}
	for _, w := range q.Windows {
		if w.ResetsAt > 0 && w.ResetsAt <= now.Unix() {
			q.Status = "stale"
		}
	}
	return q
}

func markAntigravityWindow(w *QuotaWindow) {
	w.headline = true
	lower := strings.ToLower(w.Name)
	if strings.Contains(lower, "argon") {
		w.pool = "gemini-argon"
	} else if strings.Contains(lower, "gemini") {
		w.pool = "gemini-models"
	} else if strings.Contains(lower, "claude") || strings.Contains(lower, "gpt") || strings.Contains(lower, "3p") {
		w.pool = "claude-and-gpt-models"
	} else if w.pool == "" {
		w.pool = quotaPool(w.Name)
	}
}

// ParseClaudeQuota strips the statusline payload to the quota allowlist. A
// callback without limits replaces the previous sample rather than reviving it.
func ParseClaudeQuota(data []byte, now time.Time) (AgentQuota, error) {
	q := emptyQuota("claude", "statusline", "unavailable")
	var payload struct {
		Limits map[string]struct {
			Used  *float64 `json:"used_percentage"`
			Reset int64    `json:"resets_at"`
		} `json:"rate_limits"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return q, err
	}
	q.ObservedAt = now.Unix()
	for _, spec := range []struct {
		key     string
		minutes int64
	}{{"five_hour", 300}, {"seven_day", 10080}, {"spend_limit", 0}} {
		v, ok := payload.Limits[spec.key]
		if !ok || v.Used == nil {
			continue
		}
		w := QuotaWindow{Name: spec.key, UsedPercent: *v.Used, WindowMinutes: spec.minutes, ResetsAt: v.Reset}
		if validQuotaWindow(w) && w.ResetsAt > now.Unix() {
			q.Windows = append(q.Windows, w)
		}
	}
	if len(q.Windows) > 0 {
		q.Status = "ok"
	}
	return q, nil
}
