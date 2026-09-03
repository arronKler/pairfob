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
	for _, code := range []string{"rate_limited", "not_a_code"} {
		text := enrollNotice(code)
		assertOperatorText(t, text)
		if strings.Contains(text, code) {
			t.Fatalf("raw code in notice: %q", text)
		}
	}
	if !strings.Contains(enrollNotice("rate_limited"), "too many computers") {
		t.Fatal(enrollNotice("rate_limited"))
	}
	if !strings.Contains(enrollNotice("not_a_code"), "pairfob doctor") {
		t.Fatal(enrollNotice("not_a_code"))
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
	if !strings.Contains(doctorOriginNote("PAIRFOB_JOIN_GRANT is not used"), "JOIN_GRANT") {
		t.Fatal(doctorOriginNote("PAIRFOB_JOIN_GRANT is not used"))
	}
}

func TestPairSlotErrorIsHuman(t *testing.T) {
	err := pairSlotError(errors.New("pair_ref does not match the active pairing"))
	if err == nil || !strings.Contains(err.Error(), "pairfob pair") {
		t.Fatalf("got %v", err)
	}
	assertOperatorText(t, err.Error())
	if err := pairSlotError(errors.New("pairing cancelled")); err.Error() != "pairing cancelled" {
		t.Fatalf("got %v", err)
	}
}
