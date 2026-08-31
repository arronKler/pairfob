package main

import (
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
	for _, want := range []string{"pairfob pair", "pairfob list", "pairfob forget", "pairfob update", "pairfob doctor"} {
		if !strings.Contains(usage, want) {
			t.Fatalf("help missing %s", want)
		}
	}
	for _, hide := range []string{"enroll", "service", "relay", "pair_ref", "phones"} {
		if strings.Contains(usage, hide) {
			t.Fatalf("help still shows %q", hide)
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
