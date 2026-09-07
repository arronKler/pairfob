package runtime

import (
	"encoding/json"
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
			name := bucket.Name
			if name == "" {
				name = bucket.ID
			}
			if group.Name != "" {
				name = group.Name + " / " + name
			}
			q.Windows = append(q.Windows, QuotaWindow{Name: name, UsedPercent: 100 * (1 - *fraction), ResetsAt: quotaReset(bucket.Reset)})
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
		q.Windows = append(q.Windows, QuotaWindow{Name: model.Label, UsedPercent: 100 * (1 - *model.Quota.Fraction), ResetsAt: quotaReset(model.Quota.Reset)})
	}
	return finishQuota(q, now)
}
