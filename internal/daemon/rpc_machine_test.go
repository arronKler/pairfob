package daemon

import (
	"errors"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

type machineLinkerStub struct {
	unavailable bool
	busy        bool
	starts      []string
	cancels     []string
	devices     []string
}

func (m *machineLinkerStub) Available() bool { return !m.unavailable }
func (m *machineLinkerStub) Machines() ([]Machine, error) {
	return []Machine{{ID: "b492e53d", Label: "Build machine", State: "available", DaemonID: "d_84e96fc860788018e276"}}, nil
}
func (m *machineLinkerStub) Start(deviceID, operationID, machineID string, install bool) (MachineLink, error) {
	if m.busy {
		return MachineLink{}, errors.New("a machine link is already running")
	}
	m.devices = append(m.devices, deviceID)
	m.starts = append(m.starts, operationID+" "+machineID+" "+map[bool]string{true: "install", false: "check"}[install])
	return MachineLink{OperationID: operationID, MachineID: machineID, Phase: "checking"}, nil
}
func (m *machineLinkerStub) Status(deviceID string) MachineLink {
	m.devices = append(m.devices, deviceID)
	return MachineLink{OperationID: "op_abcdefghijklmnop", MachineID: "b492e53d", Phase: "offering", PairURL: "https://pairfob.example/pair#c=7K3M9H2P"}
}
func (m *machineLinkerStub) Cancel(deviceID, operationID string) MachineLink {
	m.cancels = append(m.cancels, operationID)
	return MachineLink{OperationID: operationID, MachineID: "b492e53d", Phase: "failed", Error: "cancelled"}
}

func TestMachineLinkRPCsCarryOnlyOpaqueMachineIDs(t *testing.T) {
	e, c := runtimeRPCClient(t, runtime.NewFake())
	linker := &machineLinkerStub{}
	e.Machines = linker

	raw, err := c.RPC("ListMachines", map[string]any{})
	if err != nil || !strings.Contains(string(raw), `"label":"Build machine"`) || !strings.Contains(string(raw), `"daemon_id":"d_84e96fc860788018e276"`) {
		t.Fatalf("%s %v", raw, err)
	}
	for _, params := range []map[string]any{
		{"machine_id": "b492e53d"},
		{"operation_id": "op_abcdefghijklmnop"},
		{"operation_id": "op_abcdefghijklmnop", "machine_id": "ssh://dev@workbox"},
		{"operation_id": "op_abcdefghijklmnop", "machine_id": "b492e53d", "target": "workbox"},
	} {
		if _, err := c.RPC("LinkMachine", params); err == nil || !strings.Contains(err.Error(), "invalid_argument") {
			t.Fatalf("%v accepted: %v", params, err)
		}
	}
	raw, err = c.RPC("LinkMachine", map[string]any{"operation_id": "op_abcdefghijklmnop", "machine_id": "b492e53d", "install": true})
	if err != nil || !strings.Contains(string(raw), `"phase":"checking"`) {
		t.Fatalf("%s %v", raw, err)
	}
	if len(linker.starts) != 1 || linker.starts[0] != "op_abcdefghijklmnop b492e53d install" {
		t.Fatalf("starts = %q", linker.starts)
	}
	raw, err = c.RPC("LinkMachineStatus", map[string]any{})
	if err != nil || !strings.Contains(string(raw), `"pair_url":"https://pairfob.example/pair#c=7K3M9H2P"`) {
		t.Fatalf("%s %v", raw, err)
	}
	raw, err = c.RPC("LinkMachineCancel", map[string]any{"operation_id": "op_abcdefghijklmnop"})
	if err != nil || !strings.Contains(string(raw), `"error":"cancelled"`) || len(linker.cancels) != 1 {
		t.Fatalf("%s %v", raw, err)
	}
	for _, deviceID := range linker.devices {
		if deviceID != c.DeviceID {
			t.Fatalf("linker saw device %q, session is %q", deviceID, c.DeviceID)
		}
	}

	linker.busy = true
	if _, err := c.RPC("LinkMachine", map[string]any{"operation_id": "op_bbbbbbbbbbbbbbbb", "machine_id": "b492e53d"}); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("second link: %v", err)
	}
}

func TestMachineLinkIsAdvertisedOnlyWhenAvailable(t *testing.T) {
	e, c := runtimeRPCClient(t, runtime.NewFake())
	for name, tc := range map[string]struct {
		linker MachineLinker
		want   string
	}{
		"not configured": {want: `"link_machine":false`},
		"unavailable":    {linker: &machineLinkerStub{unavailable: true}, want: `"link_machine":false`},
		"available":      {linker: &machineLinkerStub{}, want: `"link_machine":true`},
	} {
		e.Machines = tc.linker
		raw, err := c.RPC("GetConfig", map[string]any{})
		if err != nil || !strings.Contains(string(raw), tc.want) {
			t.Fatalf("%s: %s %v", name, raw, err)
		}
		_, listErr := c.RPC("ListMachines", map[string]any{})
		_, linkErr := c.RPC("LinkMachine", map[string]any{"operation_id": "op_abcdefghijklmnop", "machine_id": "b492e53d"})
		if available := strings.HasSuffix(tc.want, "true"); (listErr == nil) != available || (linkErr == nil) != available {
			t.Fatalf("%s: list %v, link %v", name, listErr, linkErr)
		}
	}
}
