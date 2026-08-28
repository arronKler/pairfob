package main

import (
	"errors"
	"strings"
	"testing"
)

func assertOperatorText(t *testing.T, text string) {
	t.Helper()
	if strings.TrimSpace(text) == "" {
		t.Fatal("empty operator text")
	}
	leaks := []string{
		"device_psk", "reconnect_token", "join_grant", "pair_loc",
		"enroll rejected", "rekey rejected", "Error.Error", "goroutine ",
	}
	lower := strings.ToLower(text)
	for _, frag := range leaks {
		if strings.Contains(lower, strings.ToLower(frag)) {
			t.Fatalf("leaked %q in %q", frag, text)
		}
	}
}

func TestEnrollNoticesNameANextStep(t *testing.T) {
	for _, code := range []string{"bad_grant", "grant_exhausted", "not_a_code"} {
		text := enrollNotice(code)
		assertOperatorText(t, text)
		if !strings.Contains(text, "install") && !strings.Contains(text, "pairfobd doctor") {
			t.Fatalf("%s: %q", code, text)
		}
		if strings.Contains(text, code) {
			t.Fatalf("raw code in notice: %q", text)
		}
	}
	if !strings.Contains(enrollNotice("bad_grant"), "Re-run the installer") {
		t.Fatal(enrollNotice("bad_grant"))
	}
	if !strings.Contains(enrollNotice("grant_exhausted"), "Re-run the installer") {
		t.Fatal(enrollNotice("grant_exhausted"))
	}
}

func TestDoctorOriginNoteDropsInternals(t *testing.T) {
	got := doctorOriginNote("v2 relay.json url must contain daemon_id=d_abc")
	assertOperatorText(t, got)
	if strings.Contains(got, "daemon_id") {
		t.Fatalf("%q", got)
	}
	if doctorOriginNote("") != "" {
		t.Fatal("empty note should stay empty")
	}
	if !strings.Contains(doctorOriginNote("PAIRFOB_JOIN_TOKEN is not used"), "JOIN_TOKEN") {
		t.Fatal(doctorOriginNote("PAIRFOB_JOIN_TOKEN is not used"))
	}
}

func TestPairSlotErrorIsHuman(t *testing.T) {
	err := pairSlotError(errors.New("pair_ref does not match the active pairing"))
	if err == nil || !strings.Contains(err.Error(), "pairfobd pair") {
		t.Fatalf("got %v", err)
	}
	assertOperatorText(t, err.Error())
	if err := pairSlotError(errors.New("pairing cancelled")); err.Error() != "pairing cancelled" {
		t.Fatalf("got %v", err)
	}
}
