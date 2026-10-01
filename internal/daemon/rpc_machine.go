package daemon

import (
	"encoding/json"
	"regexp"
)

// Machine is another computer this one can already reach. Only its label and
// opaque ID cross to a paired device; how it is reached stays here.
type Machine struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	State    string `json:"state"`
	DaemonID string `json:"daemon_id,omitempty"`
}

// MachineLink is the one link job this computer runs at a time. PairURL holds
// a one-use pairing code and is only ever returned to the device that started
// the job.
type MachineLink struct {
	OperationID string `json:"operation_id"`
	MachineID   string `json:"machine_id"`
	Phase       string `json:"phase"`
	PairURL     string `json:"pair_url,omitempty"`
	Error       string `json:"error,omitempty"`
}

type MachineLinker interface {
	Available() bool
	Machines() ([]Machine, error)
	Start(deviceID, operationID, machineID string, install bool) (MachineLink, error)
	Status(deviceID string) MachineLink
	Cancel(deviceID, operationID string) MachineLink
}

var machineName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func (e *Engine) machineLinkAvailable() bool {
	return e.Machines != nil && e.Machines.Available()
}

func (e *Engine) rpcListMachines(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "unexpected machine list parameters")
		return
	}
	if !e.machineLinkAvailable() {
		e.replyErr(s, id, "unknown_op", "machine linking unavailable")
		return
	}
	machines, err := e.Machines.Machines()
	if err != nil {
		e.replyErr(s, id, "herdr_offline", "machine list unavailable")
		return
	}
	if machines == nil {
		machines = []Machine{}
	}
	e.reply(s, id, map[string]any{"machines": machines})
}

func (e *Engine) rpcLinkMachineStatus(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "unexpected machine link parameters")
		return
	}
	status := MachineLink{Phase: "idle"}
	if e.Machines != nil {
		status = e.Machines.Status(s.deviceID)
	}
	e.reply(s, id, status)
}

func (e *Engine) rpcLinkMachine(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string `json:"operation_id"`
		MachineID   string `json:"machine_id"`
		Install     bool   `json:"install"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || !machineName.MatchString(p.MachineID) {
		e.replyErr(s, id, "invalid_argument", "invalid machine link request")
		return
	}
	if !e.machineLinkAvailable() {
		e.replyErr(s, id, "unknown_op", "machine linking unavailable")
		return
	}
	result, err := e.Machines.Start(s.deviceID, p.OperationID, p.MachineID, p.Install)
	if err != nil {
		e.replyErr(s, id, "conflict", "machine link not accepted; refresh machine link status")
		return
	}
	e.audit("machine_link_requested", map[string]any{"device_id": s.deviceID, "operation_id": p.OperationID, "machine_id": p.MachineID, "install": p.Install})
	e.reply(s, id, result)
}

func (e *Engine) rpcLinkMachineCancel(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string `json:"operation_id"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) {
		e.replyErr(s, id, "invalid_argument", "invalid machine link request")
		return
	}
	status := MachineLink{Phase: "idle"}
	if e.Machines != nil {
		status = e.Machines.Cancel(s.deviceID, p.OperationID)
	}
	e.reply(s, id, status)
}
