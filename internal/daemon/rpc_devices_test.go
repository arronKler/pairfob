package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

func TestListDevicesOmitsRevokedAndMarksConnected(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	other := seedClient(t, eng, hub)
	if err := other.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	stalePSK := make([]byte, 32)
	if _, err := rand.Read(stalePSK); err != nil {
		t.Fatal(err)
	}
	staleID := "dev_" + hex.EncodeToString(stalePSK[:8])
	eng.PutDevice(staleID, stalePSK)
	revokedPSK := make([]byte, 32)
	if _, err := rand.Read(revokedPSK); err != nil {
		t.Fatal(err)
	}
	revokedID := "dev_" + hex.EncodeToString(revokedPSK[:8])
	eng.PutDevice(revokedID, revokedPSK)
	now := time.Now().Unix()
	eng.mu.Lock()
	eng.Devices[revokedID].RevokedAt = &now
	eng.mu.Unlock()

	raw, err := self.RPC("ListDevices", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Devices []struct {
			DeviceID  string `json:"device_id"`
			Self      bool   `json:"self"`
			Connected bool   `json:"connected"`
			RevokedAt *int64 `json:"revoked_at"`
		} `json:"devices"`
	}
	if json.Unmarshal(raw, &listed) != nil {
		t.Fatalf("list: %s", raw)
	}
	byID := map[string]struct {
		Self      bool
		Connected bool
		Revoked   bool
	}{}
	for _, row := range listed.Devices {
		byID[row.DeviceID] = struct {
			Self      bool
			Connected bool
			Revoked   bool
		}{Self: row.Self, Connected: row.Connected, Revoked: row.RevokedAt != nil}
	}
	if _, ok := byID[revokedID]; ok {
		t.Fatalf("revoked device still listed: %s", raw)
	}
	selfRow, ok := byID[self.DeviceID]
	if !ok || !selfRow.Self || !selfRow.Connected || selfRow.Revoked {
		t.Fatalf("self row: %+v listed=%s", selfRow, raw)
	}
	otherRow, ok := byID[other.DeviceID]
	if !ok || otherRow.Self || !otherRow.Connected || otherRow.Revoked {
		t.Fatalf("other row: %+v listed=%s", otherRow, raw)
	}
	staleRow, ok := byID[staleID]
	if !ok || staleRow.Self || staleRow.Connected || staleRow.Revoked {
		t.Fatalf("stale row: %+v listed=%s", staleRow, raw)
	}
	if listed.Devices[0].DeviceID != self.DeviceID {
		t.Fatalf("self should sort first: %s", raw)
	}
}

func TestRevokeDeviceAllowsAnotherPairedDevice(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	other := seedClient(t, eng, hub)
	if err := other.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}

	if _, err := self.RPC("RevokeDevice", map[string]any{
		"operation_id": "op_AQECAwQFBgcICQoL",
		"device_id":    other.DeviceID,
	}); err != nil {
		t.Fatal(err)
	}
	if eng.HasDevice(other.DeviceID) {
		t.Fatal("other device still active")
	}
	if !eng.HasDevice(self.DeviceID) {
		t.Fatal("actor was revoked")
	}

	frame, ok := other.Conn.(*mux.Pipe).RecvTimeout(time.Second)
	if !ok || frame.Typ != envelope.TypERROR {
		t.Fatalf("want revoked on other route ok=%v typ=%d", ok, frame.Typ)
	}
	var body envelope.ErrorBody
	if json.Unmarshal(frame.Payload, &body) != nil || body.Code != "revoked" {
		t.Fatalf("want revoked got %+v", body)
	}

	raw, err := self.RPC("ListDevices", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), other.DeviceID) || !strings.Contains(string(raw), self.DeviceID) {
		t.Fatalf("list after revoke: %s", raw)
	}
}

func TestRevokeDeviceMissingIsNotApplied(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	raw, err := self.RPC("RevokeDevice", map[string]any{
		"operation_id": "op_AgECAwQFBgcICQoL",
		"device_id":    "dev_missingdevice01",
	})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Outcome string `json:"outcome"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Outcome != "not_applied" {
		t.Fatalf("missing revoke: %s", raw)
	}
}
