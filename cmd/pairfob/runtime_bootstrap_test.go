package main

import "testing"

func TestHerdrAutostartPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, autostart, multiSession string
		devFake, want                 bool
	}{
		{name: "single-session default", want: true},
		{name: "multi-session default", multiSession: "1", want: true},
		{name: "single-session opt-out", autostart: "0"},
		{name: "multi-session opt-out", autostart: "0", multiSession: "1"},
		{name: "fake runtime", autostart: "1", devFake: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAIRFOB_HERDR_AUTOSTART", tc.autostart)
			t.Setenv("PAIRFOB_MULTI_SESSION", tc.multiSession)
			if got := herdrAutostartEnabled(tc.devFake); got != tc.want {
				t.Fatalf("herdrAutostartEnabled=%v, want %v", got, tc.want)
			}
		})
	}
}
