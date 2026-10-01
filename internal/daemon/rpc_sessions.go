package daemon

import (
	"context"
	"encoding/json"
	"time"

	"pairfob/internal/runtime"
)

// rpcListSessions enumerates the Herdr sessions this daemon can see. An old
// PWA never calls this op; an old daemon falls through dispatch's default
// case and replies unknown_op. A daemon whose runtime does not implement
// SessionLister (the Fake dev runtime, or Herdr with multi-session not
// enabled) replies unsupported. Both are expected, quiet ways to say "no
// switcher here" rather than errors.
func (e *Engine) rpcListSessions(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	lister, ok := e.RT.(runtime.SessionLister)
	if !ok {
		e.replyErr(s, id, "unsupported", "the live runtime does not support session listing")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sessions, err := lister.Sessions(ctx)
	if err != nil {
		e.replyRuntimeErr(s, id, err, "unsupported")
		return
	}
	out := make([]map[string]any, 0, len(sessions))
	for _, si := range sessions {
		var name any
		if si.Name != "" {
			name = si.Name
		}
		out = append(out, map[string]any{"name": name, "running": si.Running})
	}
	e.reply(s, id, map[string]any{"sessions": out})
}
