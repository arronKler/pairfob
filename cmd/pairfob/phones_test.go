package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/daemon"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

func TestPhonesListSkipsRevoked(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.PutDevice("dev_12345678", []byte("01234567890123456789012345678901"))
	eng.Devices["dev_12345678"].Label = "iPhone"
	revoked := time.Now().Unix()
	eng.PutDevice("dev_87654321", []byte("01234567890123456789012345678901"))
	eng.Devices["dev_87654321"].RevokedAt = &revoked
	sock := startLiveAdmin(t, eng)
	rows, err := loadPhones(sock)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != "dev_12345678" {
		t.Fatalf("%+v", rows)
	}
}

func TestPhonesForgetByNumber(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.PutDevice("dev_12345678", []byte("01234567890123456789012345678901"))
	eng.Devices["dev_12345678"].Label = "iPhone"
	sock := startLiveAdmin(t, eng)
	if err := runCommand([]string{"forget", "1"}, sock); err != nil {
		t.Fatal(err)
	}
	if eng.HasDevice("dev_12345678") {
		t.Fatal("device still present")
	}
}

func TestResolvePhoneByLabelAndIndex(t *testing.T) {
	rows := []admin.Device{
		{ID: "dev_aaaaaaaa", Label: "iPhone"},
		{ID: "dev_bbbbbbbb", Label: "Android 手机"},
	}
	id, err := resolvePhone(rows, "1")
	if err != nil || id != "dev_aaaaaaaa" {
		t.Fatalf("index: %q %v", id, err)
	}
	id, err = resolvePhone(rows, "Android 手机")
	if err != nil || id != "dev_bbbbbbbb" {
		t.Fatalf("label: %q %v", id, err)
	}
	if _, err := resolvePhone(rows, "9"); err == nil {
		t.Fatal("expected missing index")
	}
}

func TestHelpListsPairPhonesUpdateDoctor(t *testing.T) {
	usage := commandUsage
	for _, want := range []string{"pairfob pair", "pairfob list", "pairfob forget", "pairfob update", "pairfob doctor", "pairfob service status|start|restart|stop|install", "\n  pairfob run "} {
		if !strings.Contains(usage, want) {
			t.Fatalf("help missing %s", want)
		}
	}
	for _, hide := range []string{"enroll", "relay", "pair_ref", "phones", "uninstall"} {
		if strings.Contains(usage, hide) {
			t.Fatalf("help still shows %q", hide)
		}
	}
}

func TestWriteDevicesJSONEmitsActiveRows(t *testing.T) {
	yes, no := true, false
	var buf bytes.Buffer
	rows := []admin.Device{
		{ID: "dev_aaaaaaaa", Label: "iPhone", Created: 100, LastSeen: 200, Connected: &yes},
		{ID: "dev_bbbbbbbb", Label: "iPad", Created: 150, LastSeen: 250, Connected: &no},
		{ID: "dev_cccccccc", Created: 300},
	}
	if err := writeDevicesJSON(&buf, rows); err != nil {
		t.Fatal(err)
	}
	if strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("want one JSON line: %q", buf.String())
	}
	var got struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, buf.String())
	}
	if len(got.Devices) != 3 {
		t.Fatalf("%s", buf.String())
	}
	first := got.Devices[0]
	for key, want := range map[string]any{
		"device_id": "dev_aaaaaaaa", "label": "iPhone", "created_at": float64(100),
		"last_seen": float64(200), "connected": true,
	} {
		if first[key] != want {
			t.Fatalf("%s = %v, want %v", key, first[key], want)
		}
	}
	if len(first) != 5 {
		t.Fatalf("unexpected fields: %v", first)
	}
	if second := got.Devices[1]; second["connected"] != false {
		t.Fatalf("a known-offline row must say false: %v", second)
	}
	third := got.Devices[2]
	if _, ok := third["label"]; ok {
		t.Fatalf("an empty label must be omitted: %v", third)
	}
	if _, ok := third["connected"]; ok {
		t.Fatalf("an unknown connection state must be omitted: %v", third)
	}
	if third["last_seen"] != float64(0) {
		t.Fatalf("offline row: %v", third)
	}
	if len(third) != 3 {
		t.Fatalf("unexpected fields: %v", third)
	}
}

func TestWriteDevicesJSONEmptyList(t *testing.T) {
	var buf bytes.Buffer
	if err := writeDevicesJSON(&buf, nil); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(buf.String()); got != `{"devices":[]}` {
		t.Fatalf("got %q", got)
	}
}

func TestDeviceStatePhrasePrefersConnected(t *testing.T) {
	yes, no := true, false
	if got := deviceStatePhrase(admin.Device{LastSeen: time.Now().Add(-time.Hour).Unix(), Connected: &yes}); got != "connected" {
		t.Fatalf("got %q", got)
	}
	if got := deviceStatePhrase(admin.Device{LastSeen: time.Now().Unix(), Connected: &no}); got != "just now" {
		t.Fatalf("got %q", got)
	}
	if got := deviceStatePhrase(admin.Device{LastSeen: time.Now().Unix()}); got != "just now" {
		t.Fatalf("got %q", got)
	}
	if got := deviceStatePhrase(admin.Device{}); got != "never seen" {
		t.Fatalf("got %q", got)
	}
}

func TestDevicesJSONDispatches(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	sock := startLiveAdmin(t, eng)
	for _, args := range [][]string{{"devices", "--json"}, {"devices", "list", "--json"}} {
		if err := runCommand(args, sock); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestLastSeenPhrase(t *testing.T) {
	if lastSeenPhrase(0) != "never seen" {
		t.Fatal(lastSeenPhrase(0))
	}
	if got := lastSeenPhrase(time.Now().Unix()); got != "just now" {
		t.Fatalf("got %q", got)
	}
}
