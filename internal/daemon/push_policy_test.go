package daemon

import "testing"

func TestPushKindForTransition(t *testing.T) {
	tests := []struct {
		name       string
		previous   string
		known      bool
		current    string
		wantKind   PushKind
		wantNotify bool
	}{
		{name: "initial blocked is quiet", current: "blocked"},
		{name: "idle to blocked needs user", previous: "idle", known: true, current: "blocked", wantKind: PushNeedsYou, wantNotify: true},
		{name: "working to blocked needs user", previous: "working", known: true, current: "blocked", wantKind: PushNeedsYou, wantNotify: true},
		{name: "repeated blocked is quiet", previous: "blocked", known: true, current: "blocked"},
		{name: "working to done completes", previous: "working", known: true, current: "done", wantKind: PushDone, wantNotify: true},
		{name: "idle to done is not a completion", previous: "idle", known: true, current: "done"},
		{name: "blocked to done waits for a working transition", previous: "blocked", known: true, current: "done"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			kind, notify := pushKindForTransition(test.previous, test.known, test.current)
			if kind != test.wantKind || notify != test.wantNotify {
				t.Fatalf("got (%q, %v), want (%q, %v)", kind, notify, test.wantKind, test.wantNotify)
			}
		})
	}
}

func TestNotifyHerdRejectsInvalidIdentityAndKind(t *testing.T) {
	engine := &Engine{}
	if err := engine.NotifyHerd(HerdPush{HerdID: "/private/path", Kind: PushDone}); err == nil {
		t.Fatal("invalid pane id was accepted")
	}
	if err := engine.NotifyHerd(HerdPush{HerdID: "w0:p1", Kind: "other"}); err == nil {
		t.Fatal("invalid notification kind was accepted")
	}
}
