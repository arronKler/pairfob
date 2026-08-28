package daemon

import "testing"

func TestRuntimeAvailabilityPokesOnFirstObservationAndTransitions(t *testing.T) {
	tests := []struct {
		name    string
		current runtimeAvailability
		online  bool
		next    runtimeAvailability
		reason  string
	}{
		{name: "initial offline", current: runtimeUnknown, next: runtimeOffline, reason: "herdr_offline"},
		{name: "initial online", current: runtimeUnknown, online: true, next: runtimeOnline, reason: "herdr_online"},
		{name: "stays offline", current: runtimeOffline, next: runtimeOffline},
		{name: "recovers", current: runtimeOffline, online: true, next: runtimeOnline, reason: "herdr_online"},
		{name: "stays online", current: runtimeOnline, online: true, next: runtimeOnline},
		{name: "drops offline", current: runtimeOnline, next: runtimeOffline, reason: "herdr_offline"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			next, reason := transitionRuntimeAvailability(test.current, test.online)
			if next != test.next || reason != test.reason {
				t.Fatalf("next=%v reason=%q, want next=%v reason=%q", next, reason, test.next, test.reason)
			}
		})
	}
}
