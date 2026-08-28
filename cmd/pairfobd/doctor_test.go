package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestWriteDoctorIsHuman(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{
		Version: "dev", Running: true, Phones: 2, HerdrOK: true, HerdrNote: "on", Origin: "pairfob.com",
	})
	got := buf.String()
	if strings.Contains(got, "{") || strings.Contains(got, "daemon_id") {
		t.Fatalf("doctor leaked internals: %s", got)
	}
	if !strings.Contains(got, "Running") || !strings.Contains(got, "Paired") || !strings.Contains(got, "Herdr") || !strings.Contains(got, "Origin") {
		t.Fatalf("doctor missing checklist: %s", got)
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

func TestWriteLiveSnapshot(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev", Running: false, HerdrNote: "off — open Herdr on this computer"})
	if !strings.Contains(buf.String(), "no —") {
		t.Fatalf("%s", buf.String())
	}
}
