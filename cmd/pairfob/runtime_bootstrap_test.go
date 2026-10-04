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

func TestHerdrMultiSessionPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, multiSession, socket string
		want                       bool
	}{
		{name: "default", want: true},
		{name: "explicit on", multiSession: "1", want: true},
		{name: "explicit on with pinned socket", multiSession: "1", socket: "/tmp/herdr.sock", want: true},
		{name: "explicit off", multiSession: "0"},
		{name: "explicit off with pinned socket", multiSession: "0", socket: "/tmp/herdr.sock"},
		{name: "pinned socket default", socket: "/tmp/herdr.sock"},
		{name: "unknown value", multiSession: "true"},
		{name: "unknown value with pinned socket", multiSession: "true", socket: "/tmp/herdr.sock"},
		// Herdr exports the default socket into every default-session pane;
		// installing from one must not pin the daemon.
		{name: "default socket from pane", socket: "/home/u/.config/herdr/herdr.sock", want: true},
		{name: "default socket uncleaned", socket: "/home/u/.config/herdr/../herdr/herdr.sock", want: true},
		{name: "default socket explicit off", multiSession: "0", socket: "/home/u/.config/herdr/herdr.sock"},
		{name: "named session socket", socket: "/home/u/.config/herdr/sessions/work/herdr.sock"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", "/home/u")
			t.Setenv("PAIRFOB_MULTI_SESSION", tc.multiSession)
			t.Setenv("HERDR_SOCKET_PATH", tc.socket)
			if got := herdrMultiSessionEnabled(); got != tc.want {
				t.Fatalf("herdrMultiSessionEnabled=%v, want %v", got, tc.want)
			}
		})
	}
}
