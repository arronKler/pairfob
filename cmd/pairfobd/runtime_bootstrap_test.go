package main

import "testing"

func TestHerdrAutostartPolicy(t *testing.T) {
	t.Setenv("PAIRFOB_HERDR_AUTOSTART", "")
	if !herdrAutostartEnabled(false, false) {
		t.Fatal("default single-session runtime should auto-start Herdr")
	}

	t.Setenv("PAIRFOB_HERDR_AUTOSTART", "0")
	if herdrAutostartEnabled(false, false) {
		t.Fatal("explicit opt-out was ignored")
	}

	t.Setenv("PAIRFOB_HERDR_AUTOSTART", "1")
	if herdrAutostartEnabled(true, false) {
		t.Fatal("fake runtime must not start Herdr")
	}
	if herdrAutostartEnabled(false, true) {
		t.Fatal("multi-session mode must not guess which Herdr server to start")
	}
}
