package daemon

import "testing"

func TestListDeviceSummariesMarksConnectedSessions(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	live := seedClient(t, eng, hub)
	if err := live.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	eng.PutDevice("dev_idle00000000", make([]byte, 32))

	byID := map[string]DeviceSummary{}
	for _, row := range eng.ListDeviceSummaries() {
		byID[row.ID] = row
	}
	liveRow, ok := byID[live.DeviceID]
	if !ok || !liveRow.Connected {
		t.Fatalf("resumed device row: %+v listed=%v", liveRow, ok)
	}
	idleRow, ok := byID["dev_idle00000000"]
	if !ok || idleRow.Connected {
		t.Fatalf("device without a session: %+v listed=%v", idleRow, ok)
	}
}
