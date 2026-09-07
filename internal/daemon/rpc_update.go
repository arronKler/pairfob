package daemon

import "encoding/json"

type UpdateStatus struct {
	Available   bool   `json:"available"`
	Phase       string `json:"phase"`
	Target      string `json:"target"`
	OperationID string `json:"operation_id"`
}
type Updater interface {
	Status() UpdateStatus
	Start(operationID, target string) (UpdateStatus, error)
}

func (e *Engine) rpcUpdate(s *sess, id string, params json.RawMessage, start bool) {
	if !start {
		var p struct{}
		if badParams(params, &p) {
			e.replyErr(s, id, "invalid_argument", "unexpected update parameters")
			return
		}
		status := UpdateStatus{Phase: "idle"}
		if e.Updater != nil {
			status = e.Updater.Status()
		}
		e.reply(s, id, status)
		return
	}
	var p struct {
		OperationID string `json:"operation_id"`
		Target      string `json:"target"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || len(p.Target) == 0 || len(p.Target) > 64 {
		e.replyErr(s, id, "invalid_argument", "invalid update request")
		return
	}
	if e.Updater == nil {
		e.replyErr(s, id, "unknown_op", "computer update unavailable")
		return
	}
	result, err := e.Updater.Start(p.OperationID, p.Target)
	if err != nil {
		e.replyErr(s, id, "conflict", "update not accepted; refresh update status")
		return
	}
	e.audit("daemon_update_requested", map[string]any{"device_id": s.deviceID, "operation_id": p.OperationID, "target": p.Target})
	e.reply(s, id, result)
}
