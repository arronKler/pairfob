package daemon

import (
	"bytes"
	"encoding/json"
	"pairfob/internal/runtime"
)

// Empty params retain the full final response. Compact clients opt in to an
// ordered completion manifest so each account's payload crosses the wire once.
func (e *Engine) rpcAgentQuotaStream(s *sess, id string, params json.RawMessage) {
	var p struct {
		Compact json.RawMessage `json:"compact"`
	}
	if badParams(params, &p) || (len(p.Compact) > 0 && !bytes.Equal(p.Compact, []byte("true")) && !bytes.Equal(p.Compact, []byte("false"))) {
		e.replyErr(s, id, "invalid_argument", "AgentQuotaStream accepts only compact")
		return
	}
	compact := bytes.Equal(p.Compact, []byte("true"))
	sent := map[string]bool{}
	readings, err := e.quotaBatch(func(items []runtime.QuotaAccount) {
		if e.reply(s, id, map[string]any{"items": items, "done": false}) {
			for _, item := range items {
				sent[item.ID] = true
			}
		}
	})
	if err != nil {
		e.replyErr(s, id, "internal", "subscription quota query timed out")
		return
	}
	e.reply(s, id, quotaStreamCompletion(readings, sent, compact))
}

func quotaStreamCompletion(readings []runtime.QuotaReading, sent map[string]bool, compact bool) map[string]any {
	items := make([]runtime.QuotaAccount, 0, len(readings))
	order := make([]string, 0, len(readings))
	for _, reading := range readings {
		order = append(order, reading.Account.ID)
		if !compact || !sent[reading.Account.ID] {
			items = append(items, reading.Account)
		}
	}
	result := map[string]any{"items": items, "done": true}
	if compact {
		result["order"] = order
	}
	return result
}
