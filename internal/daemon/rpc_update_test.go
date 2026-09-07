package daemon

import (
	"pairfob/internal/runtime"
	"strings"
	"testing"
)

type updaterStub struct{ calls int }

func (u *updaterStub) Status() UpdateStatus { return UpdateStatus{Available: true, Phase: "idle"} }
func (u *updaterStub) Start(id, target string) (UpdateStatus, error) {
	u.calls++
	return UpdateStatus{Available: true, Phase: "downloading", Target: target, OperationID: id}, nil
}
func TestUpdateRPCRequiresOperationIDAndRejectsCallerDownloadURL(t *testing.T) {
	e, c := runtimeRPCClient(t, runtime.NewFake())
	u := &updaterStub{}
	e.Updater = u
	for _, params := range []map[string]any{{"target": "1.1.0"}, {"operation_id": "op_abcdefghijklmnop", "target": "1.1.0", "url": "https://evil.invalid"}} {
		if _, err := c.RPC("DaemonUpdate", params); err == nil || !strings.Contains(err.Error(), "invalid_argument") {
			t.Fatalf("%v", err)
		}
	}
	raw, err := c.RPC("DaemonUpdate", map[string]any{"operation_id": "op_abcdefghijklmnop", "target": "1.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if u.calls != 1 || !strings.Contains(string(raw), `"phase":"downloading"`) {
		t.Fatalf("%s calls %d", raw, u.calls)
	}
	if _, err := c.RPC("DaemonUpdateStatus", map[string]any{"force": true}); err == nil {
		t.Fatal("accepted unknown status parameter")
	}
}
