package main

import (
	"bytes"
	"strings"
	"testing"
)

func testBool(value bool) *bool { return &value }

func TestWriteDoctorIsHuman(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{
		Version: "dev", Running: true, Phones: 2, HerdrOK: true, HerdrNote: "on", Origin: "pairfob.com", P2P: testBool(true),
	})
	got := buf.String()
	if strings.Contains(got, "{") || strings.Contains(got, "daemon_id") {
		t.Fatalf("doctor leaked internals: %s", got)
	}
	if !strings.Contains(got, "Running") || !strings.Contains(got, "Paired") || !strings.Contains(got, "Herdr") || !strings.Contains(got, "Origin") || !strings.Contains(got, "P2P") {
		t.Fatalf("doctor missing checklist: %s", got)
	}
	if !strings.Contains(got, "P2P         on") {
		t.Fatalf("doctor missing P2P on: %s", got)
	}
}

func TestWriteDoctorSanitizesOriginNote(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{
		Version: "dev", Origin: "pairfob.com",
		OriginNote: `v2 relay.json url must contain daemon_id=d_abc {"reconnect_token":"rt_x"}`,
	})
	got := buf.String()
	assertOperatorText(t, got)
	if strings.Contains(got, "daemon_id") || strings.Contains(got, "reconnect_token") || strings.Contains(got, "{") {
		t.Fatalf("doctor leaked internals: %s", got)
	}
	if !strings.Contains(got, "Origin") || !strings.Contains(got, "incomplete") {
		t.Fatalf("doctor missing sanitized origin note: %s", got)
	}
}

func TestWriteDoctorP2POff(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev", P2P: testBool(false), HerdrNote: "on"})
	if !strings.Contains(buf.String(), "off — this computer is relay-only") {
		t.Fatalf("%s", buf.String())
	}
}

func TestWriteDoctorP2PUnknown(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev", HerdrNote: "on"})
	if !strings.Contains(buf.String(), "unknown — restart Pairfob to check") {
		t.Fatalf("%s", buf.String())
	}
}

func TestWriteLiveSnapshot(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev", Running: false, HerdrNote: "off — open Herdr on this computer"})
	if !strings.Contains(buf.String(), "no —") {
		t.Fatalf("%s", buf.String())
	}
}
