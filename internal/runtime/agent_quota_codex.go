package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sort"
	"time"
)

// A short-lived app-server performs only account reads. It never creates a
// thread or turn. Its stdout/stderr and raw account response are not forwarded.
func readCodexQuota(parent context.Context) AgentQuota {
	q := emptyQuota("codex", "app_server", "unavailable")
	path, err := exec.LookPath("codex")
	if err != nil {
		q.Status = "not_installed"
		return q
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "app-server")
	cmd.Dir, _ = os.UserHomeDir()
	cmd.WaitDelay = time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		return q
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return q
	}
	if err = cmd.Start(); err != nil {
		return q
	}
	stopClose := context.AfterFunc(ctx, func() { _ = output.Close() })
	defer stopClose()
	defer func() { _ = input.Close(); cancel(); _ = cmd.Wait() }()
	scan := bufio.NewScanner(io.LimitReader(output, 2*1024*1024))
	scan.Buffer(make([]byte, 4096), 256*1024)
	send := func(v any) error { return json.NewEncoder(input).Encode(v) }
	if send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]string{"name": "pairfob_quota", "version": "1.0"}}}) != nil {
		return q
	}
	if _, err = codexQuotaReply(scan, 1); err != nil {
		return q
	}
	if send(map[string]any{"method": "initialized", "params": map[string]any{}}) != nil {
		return q
	}
	if send(map[string]any{"id": 2, "method": "account/read", "params": map[string]any{"refreshToken": false}}) != nil {
		return q
	}
	account, err := codexQuotaReply(scan, 2)
	if err != nil {
		return q
	}
	var auth struct {
		Account *struct {
			Type string `json:"type"`
			Plan string `json:"planType"`
		} `json:"account"`
	}
	if json.Unmarshal(account, &auth) != nil {
		return q
	}
	if auth.Account == nil {
		q.Status = "not_logged_in"
		return q
	}
	if auth.Account.Type == "apiKey" || auth.Account.Type == "bedrock" {
		q.Status = "unsupported"
		return q
	}
	if send(map[string]any{"id": 3, "method": "account/rateLimits/read"}) != nil {
		return q
	}
	raw, err := codexQuotaReply(scan, 3)
	if err != nil {
		return q
	}
	return parseCodexQuota(raw, auth.Account.Plan, time.Now())
}

func codexQuotaReply(scan *bufio.Scanner, id int) (json.RawMessage, error) {
	for scan.Scan() {
		var msg struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(scan.Bytes(), &msg) != nil || msg.ID != id {
			continue
		}
		if len(msg.Error) > 0 && string(msg.Error) != "null" {
			return nil, errors.New("account read failed")
		}
		if len(msg.Result) == 0 {
			return nil, errors.New("missing account result")
		}
		return msg.Result, nil
	}
	return nil, errors.New("account response unavailable")
}

type codexQuotaWindow struct {
	Used    *float64 `json:"usedPercent"`
	Minutes int64    `json:"windowDurationMins"`
	Reset   int64    `json:"resetsAt"`
}
type codexQuotaBucket struct {
	Name      string            `json:"limitName"`
	Plan      string            `json:"planType"`
	Primary   *codexQuotaWindow `json:"primary"`
	Secondary *codexQuotaWindow `json:"secondary"`
}

func parseCodexQuota(raw []byte, plan string, now time.Time) AgentQuota {
	q := emptyQuota("codex", "app_server", "unavailable")
	var result struct {
		Single  *codexQuotaBucket           `json:"rateLimits"`
		Buckets map[string]codexQuotaBucket `json:"rateLimitsByLimitId"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return q
	}
	if len(result.Buckets) == 0 && result.Single != nil {
		result.Buckets = map[string]codexQuotaBucket{"codex": *result.Single}
	}
	if len(result.Buckets) > 16 {
		return q
	}
	keys := make([]string, 0, len(result.Buckets))
	for key := range result.Buckets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if len(key) > 128 || key == "" {
			return emptyQuota("codex", "app_server", "unavailable")
		}
		b := result.Buckets[key]
		if plan == "" {
			plan = b.Plan
		}
		for _, v := range []*codexQuotaWindow{b.Primary, b.Secondary} {
			if v == nil {
				continue
			}
			if v.Used == nil {
				return emptyQuota("codex", "app_server", "unavailable")
			}
			name := key
			if b.Name != "" && len(b.Name) <= 160 {
				name = b.Name
			}
			w := QuotaWindow{Name: name, UsedPercent: *v.Used, WindowMinutes: v.Minutes, ResetsAt: v.Reset}
			if !validQuotaWindow(w) {
				return emptyQuota("codex", "app_server", "unavailable")
			}
			q.Windows = append(q.Windows, w)
		}
	}
	if len(plan) <= 80 {
		q.Plan = plan
	}
	q.ObservedAt = now.Unix()
	if len(q.Windows) > 0 {
		q.Status = "ok"
	}
	for _, w := range q.Windows {
		if w.ResetsAt > 0 && w.ResetsAt <= now.Unix() {
			q.Status = "stale"
		}
	}
	return q
}
