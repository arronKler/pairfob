package runtime

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type antigravityQuotaBucket struct {
	ID        string   `json:"bucketId"`
	Name      string   `json:"displayName"`
	Disabled  bool     `json:"disabled"`
	Fraction  *float64 `json:"remainingFraction"`
	Remaining *struct {
		Fraction *float64 `json:"remainingFraction"`
		Case     string   `json:"case"`
		Value    *float64 `json:"value"`
	} `json:"remaining"`
	Reset string `json:"resetTime"`
}
type antigravityQuotaGroup struct {
	Name    string                   `json:"displayName"`
	Buckets []antigravityQuotaBucket `json:"buckets"`
}
type antigravityModelQuota struct {
	Label string `json:"label"`
	Quota *struct {
		Fraction *float64 `json:"remainingFraction"`
		Reset    string   `json:"resetTime"`
	} `json:"quotaInfo"`
}

// Each model bucket meters its own usage and none is the plan's total, so
// every one is marked as standing for the account: the tightest is what matters.
func parseAntigravityQuota(raw []byte, now time.Time) AgentQuota {
	q := emptyQuota("antigravity", "local_api", "unavailable")
	var payload struct {
		Code     json.RawMessage         `json:"code"`
		Groups   []antigravityQuotaGroup `json:"groups"`
		Response *struct {
			Groups []antigravityQuotaGroup `json:"groups"`
		} `json:"response"`
		Summary *struct {
			Groups []antigravityQuotaGroup `json:"groups"`
		} `json:"summary"`
		Models []antigravityModelQuota `json:"clientModelConfigs"`
		User   *struct {
			Tier *struct {
				Name string `json:"name"`
			} `json:"userTier"`
			Plan *struct {
				Info *struct {
					Name    string `json:"planName"`
					Display string `json:"planDisplayName"`
				} `json:"planInfo"`
			} `json:"planStatus"`
			Models *struct {
				Items []antigravityModelQuota `json:"clientModelConfigs"`
			} `json:"cascadeModelConfigData"`
		} `json:"userStatus"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return q
	}
	if len(payload.Code) > 0 {
		code := strings.ToLower(string(payload.Code))
		if code != "null" && code != "0" && code != `"0"` && code != `"ok"` && code != `"success"` {
			return q
		}
	}
	groups := payload.Groups
	if payload.Response != nil {
		groups = payload.Response.Groups
	} else if payload.Summary != nil {
		groups = payload.Summary.Groups
	}
	if len(groups) > 32 {
		return q
	}
	for _, group := range groups {
		if len(group.Buckets) > 32 {
			return emptyQuota("antigravity", "local_api", "unavailable")
		}
		for _, bucket := range group.Buckets {
			if bucket.Disabled {
				continue
			}
			fraction := bucket.Fraction
			if fraction == nil && bucket.Remaining != nil {
				fraction = bucket.Remaining.Fraction
				if fraction == nil && bucket.Remaining.Case == "remainingFraction" {
					fraction = bucket.Remaining.Value
				}
			}
			if fraction == nil {
				continue
			} // Model availability is not proof of unused quota.
			name, pool := antigravityBucketName(group.Name, bucket.ID, bucket.Name)
			q.Windows = append(q.Windows, QuotaWindow{Name: name, UsedPercent: 100 * (1 - *fraction), ResetsAt: quotaReset(bucket.Reset), pool: pool, headline: true})
		}
	}
	if len(q.Windows) > 0 {
		return finishQuota(q, now)
	}
	models := payload.Models
	if payload.User != nil {
		if payload.User.Tier != nil {
			q.Plan = payload.User.Tier.Name
		}
		if q.Plan == "" && payload.User.Plan != nil && payload.User.Plan.Info != nil {
			q.Plan = payload.User.Plan.Info.Display
			if q.Plan == "" {
				q.Plan = payload.User.Plan.Info.Name
			}
		}
		if payload.User.Models != nil {
			models = payload.User.Models.Items
		}
	}
	if len(models) > 32 {
		return q
	}
	for _, model := range models {
		if model.Quota == nil || model.Quota.Fraction == nil {
			continue
		}
		q.Windows = append(q.Windows, QuotaWindow{Name: model.Label, UsedPercent: 100 * (1 - *model.Quota.Fraction), ResetsAt: quotaReset(model.Quota.Reset), pool: quotaPool(model.Label), headline: true})
	}
	return finishQuota(q, now)
}

// ParseAntigravityStatuslineQuota strips the statusline payload to the quota
// allowlist and distinguishes Gemini, Gemini Argon, and 3P models.
func ParseAntigravityStatuslineQuota(data []byte, now time.Time) (AgentQuota, error) {
	q := emptyQuota("antigravity", "statusline", "unavailable")
	var payload struct {
		PlanTier string `json:"plan_tier"`
		Model    struct {
			DisplayName string `json:"display_name"`
			ID          string `json:"id"`
		} `json:"model"`
		Quota map[string]struct {
			Fraction *float64 `json:"remaining_fraction"`
			Reset    string   `json:"reset_time"`
		} `json:"quota"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return q, err
	}
	if len(payload.Quota) == 0 {
		return q, errors.New("missing antigravity statusline quota")
	}
	q.Plan = payload.PlanTier
	if len(q.Plan) > 80 {
		q.Plan = ""
	}
	q.ObservedAt = now.Unix()

	type bucketDef struct {
		key  string
		name string
		pool string
	}
	defs := []bucketDef{
		{"gemini-5h", "Gemini 5h", "gemini-models"},
		{"gemini-weekly", "Gemini 7d", "gemini-models"},
		{"gemini-argon-wtu-weekly", "Argon 7d", "gemini-argon"},
		{"3p-5h", "Claude/GPT 5h", "claude-and-gpt-models"},
		{"3p-weekly", "Claude/GPT 7d", "claude-and-gpt-models"},
	}
	seen := map[string]bool{}
	for _, def := range defs {
		seen[def.key] = true
		b, ok := payload.Quota[def.key]
		if !ok || b.Fraction == nil {
			continue
		}
		rem := *b.Fraction
		if rem < 0 {
			rem = 0
		} else if rem > 1 {
			rem = 1
		}
		w := QuotaWindow{
			Name:        def.name,
			UsedPercent: 100 * (1 - rem),
			ResetsAt:    quotaReset(b.Reset),
			pool:        def.pool,
			headline:    true,
		}
		if validQuotaWindow(w) {
			q.Windows = append(q.Windows, w)
		}
	}
	for key, b := range payload.Quota {
		if seen[key] || b.Fraction == nil {
			continue
		}
		rem := *b.Fraction
		if rem < 0 {
			rem = 0
		} else if rem > 1 {
			rem = 1
		}
		name, pool := antigravityBucketName("", key, "")
		w := QuotaWindow{
			Name:        name,
			UsedPercent: 100 * (1 - rem),
			ResetsAt:    quotaReset(b.Reset),
			pool:        pool,
			headline:    true,
		}
		if validQuotaWindow(w) {
			q.Windows = append(q.Windows, w)
		}
	}
	if len(q.Windows) > 0 {
		q.Status = "ok"
	}
	return q, nil
}

func antigravityBucketName(group, bucketID, bucketName string) (string, string) {
	lowerID := strings.ToLower(bucketID)
	lowerName := strings.ToLower(bucketName)
	lowerGroup := strings.ToLower(group)

	if strings.Contains(lowerID, "argon") || strings.Contains(lowerName, "argon") {
		return "Argon 7d", "gemini-argon"
	}
	if strings.Contains(lowerGroup, "claude") || strings.Contains(lowerGroup, "gpt") || strings.Contains(lowerID, "3p") {
		if strings.Contains(lowerID, "5h") || strings.Contains(lowerName, "five hour") || strings.Contains(lowerName, "5h") {
			return "Claude/GPT 5h", "claude-and-gpt-models"
		}
		if strings.Contains(lowerID, "weekly") || strings.Contains(lowerName, "weekly") || strings.Contains(lowerName, "7d") {
			return "Claude/GPT 7d", "claude-and-gpt-models"
		}
	}
	if strings.Contains(lowerGroup, "gemini") || strings.Contains(lowerID, "gemini") {
		if strings.Contains(lowerID, "5h") || strings.Contains(lowerName, "five hour") || strings.Contains(lowerName, "5h") {
			return "Gemini 5h", "gemini-models"
		}
		if strings.Contains(lowerID, "weekly") || strings.Contains(lowerName, "weekly") || strings.Contains(lowerName, "7d") {
			return "Gemini 7d", "gemini-models"
		}
	}
	name := bucketName
	if name == "" {
		name = bucketID
	}
	if group != "" {
		name = group + " / " + name
	}
	return name, quotaPool(name)
}
