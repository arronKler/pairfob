package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"pairfob/internal/daemon"
)

func withVersion(t *testing.T, v string) {
	t.Helper()
	previous := version
	version = v
	t.Cleanup(func() { version = previous })
}

func readAutoUpdateNote(t *testing.T, path string) autoUpdateNote {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var note autoUpdateNote
	if err := json.Unmarshal(data, &note); err != nil {
		t.Fatal(err)
	}
	return note
}

func TestAutoUpdateStep(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	soak := 12 * time.Hour
	cases := []struct {
		name      string
		note      autoUpdateNote
		current   string
		target    string
		wantNote  autoUpdateNote
		wantStart bool
	}{
		{
			name:     "first sight records first_seen",
			current:  "1.0.0",
			target:   "1.0.1",
			wantNote: autoUpdateNote{Target: "1.0.1", FirstSeen: now.Unix()},
		},
		{
			name:      "starts after soak",
			note:      autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix()},
			current:   "1.0.0",
			target:    "1.0.1",
			wantNote:  autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix()},
			wantStart: true,
		},
		{
			name:     "within soak does not start",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-time.Hour).Unix()},
			current:  "1.0.0",
			target:   "1.0.1",
			wantNote: autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-time.Hour).Unix()},
		},
		{
			name:     "newer target restarts soak",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix()},
			current:  "1.0.0",
			target:   "1.0.2",
			wantNote: autoUpdateNote{Target: "1.0.2", FirstSeen: now.Unix()},
		},
		{
			name:     "target not newer clears note",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Unix()},
			current:  "1.0.1",
			target:   "1.0.1",
			wantNote: autoUpdateNote{},
		},
		{
			name:     "invalid target clears note",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Unix()},
			current:  "1.0.0",
			target:   "not-a-version",
			wantNote: autoUpdateNote{},
		},
		{
			name:     "attempted target is not retried",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix(), Attempted: "1.0.1"},
			current:  "1.0.0",
			target:   "1.0.1",
			wantNote: autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix(), Attempted: "1.0.1"},
		},
		{
			name:     "newer target restarts after an attempt",
			note:     autoUpdateNote{Target: "1.0.1", FirstSeen: now.Add(-13 * time.Hour).Unix(), Attempted: "1.0.1"},
			current:  "1.0.0",
			target:   "1.0.2",
			wantNote: autoUpdateNote{Target: "1.0.2", FirstSeen: now.Unix()},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotNote, gotStart := autoUpdateStep(tc.note, now, tc.current, tc.target, soak)
			if gotNote != tc.wantNote {
				t.Fatalf("note = %+v, want %+v", gotNote, tc.wantNote)
			}
			if gotStart != tc.wantStart {
				t.Fatalf("start = %v, want %v", gotStart, tc.wantStart)
			}
		})
	}
}

type autoUpdateFixture struct {
	a           *autoUpdater
	updater     *remoteUpdater
	started     chan string
	now         time.Time
	target      string
	fetched     int
	busyOnFetch bool
}

func newAutoUpdateFixture(t *testing.T) *autoUpdateFixture {
	t.Helper()
	f := &autoUpdateFixture{
		updater: &remoteUpdater{dir: t.TempDir(), available: true, job: daemon.UpdateStatus{Phase: "idle"}},
		started: make(chan string, 4),
		now:     time.Unix(1_700_000_000, 0),
	}
	f.updater.run = func(target string) error { f.started <- target; return nil }
	f.a = newAutoUpdater(nil, f.updater, f.updater.dir, nil)
	f.a.now = func() time.Time { return f.now }
	f.a.idle = func(time.Duration) bool { return true }
	f.a.fetch = func(context.Context) (string, error) {
		f.fetched++
		if f.busyOnFetch {
			f.setPhase("downloading")
		}
		return f.target, nil
	}
	return f
}

func (f *autoUpdateFixture) setPhase(phase string) {
	f.updater.mu.Lock()
	f.updater.job.Phase = phase
	f.updater.mu.Unlock()
}

func (f *autoUpdateFixture) assertStarted(t *testing.T, want string) {
	t.Helper()
	select {
	case got := <-f.started:
		if got != want {
			t.Fatalf("started %q, want %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatalf("expected a start of %q", want)
	}
}

func (f *autoUpdateFixture) assertNoStart(t *testing.T) {
	t.Helper()
	select {
	case got := <-f.started:
		t.Fatalf("unexpected start of %q", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestAutoUpdaterRecordsFirstSightWithoutStarting(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	note := readAutoUpdateNote(t, f.a.notePath())
	if note != (autoUpdateNote{Target: "1.0.1", FirstSeen: f.now.Unix()}) {
		t.Fatalf("note = %+v", note)
	}
}

func TestAutoUpdaterStartsAfterSoak(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	f.now = f.now.Add(f.a.soak)
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertStarted(t, "1.0.1")
}

func TestAutoUpdaterMinorBumpNeedsMinorOK(t *testing.T) {
	withVersion(t, "1.0.0")
	blocked := newAutoUpdateFixture(t)
	blocked.target = "1.1.0"
	if err := blocked.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	blocked.assertNoStart(t)
	if blocked.fetched != 1 {
		t.Fatalf("fetched = %d, want 1", blocked.fetched)
	}
	if _, err := os.Stat(blocked.a.notePath()); !os.IsNotExist(err) {
		t.Fatalf("patch filter wrote a note: %v", err)
	}

	allowed := newAutoUpdateFixture(t)
	allowed.target = "1.1.0"
	allowed.a.minorOK = true
	if err := allowed.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	allowed.now = allowed.now.Add(allowed.a.soak)
	if err := allowed.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	allowed.assertStarted(t, "1.1.0")
}

func TestAutoUpdaterDisabledEnvSkipsFetch(t *testing.T) {
	t.Setenv("PAIRFOB_AUTO_UPDATE", "0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if f.a.enabled {
		t.Fatal("enabled with PAIRFOB_AUTO_UPDATE=0")
	}
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.fetched != 0 {
		t.Fatalf("fetched = %d, want 0", f.fetched)
	}
	f.assertNoStart(t)
}

func TestAutoUpdaterIdleDefersStartAndKeepsNote(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(f.a.soak)
	f.a.idle = func(time.Duration) bool { return false }
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	if note := readAutoUpdateNote(t, f.a.notePath()); note.Target != "1.0.1" || note.Attempted != "" {
		t.Fatalf("note = %+v", note)
	}
	f.a.idle = func(time.Duration) bool { return true }
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertStarted(t, "1.0.1")
}

func TestAutoUpdaterStartsATargetOnce(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(f.a.soak)
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertStarted(t, "1.0.1")
	f.setPhase("failed")
	f.now = f.now.Add(f.a.every)
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	if note := readAutoUpdateNote(t, f.a.notePath()); note.Attempted != "1.0.1" {
		t.Fatalf("note = %+v", note)
	}
}

func TestAutoUpdaterStartFailureIsNotRetried(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(f.a.soak)
	// The updater turns busy between the tick's phase check and Start, so Start
	// rejects the attempt and the note still records it as tried.
	f.busyOnFetch = true
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	if note := readAutoUpdateNote(t, f.a.notePath()); note.Attempted != "1.0.1" {
		t.Fatalf("note = %+v", note)
	}
	f.busyOnFetch = false
	f.setPhase("idle")
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)

	f.target = "1.0.2"
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	f.now = f.now.Add(f.a.soak)
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertStarted(t, "1.0.2")
}

func TestAutoUpdaterTreatsUnparsableNoteAsZero(t *testing.T) {
	withVersion(t, "1.0.0")
	f := newAutoUpdateFixture(t)
	f.target = "1.0.1"
	if err := os.WriteFile(f.a.notePath(), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.a.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.assertNoStart(t)
	if note := readAutoUpdateNote(t, f.a.notePath()); note != (autoUpdateNote{Target: "1.0.1", FirstSeen: f.now.Unix()}) {
		t.Fatalf("note = %+v", note)
	}
}

func TestDurationEnvFallsBackOnBadValues(t *testing.T) {
	t.Setenv("PAIRFOB_AUTO_UPDATE_SOAK", "30s")
	if got := durationEnv("PAIRFOB_AUTO_UPDATE_SOAK", 12*time.Hour); got != 12*time.Hour {
		t.Fatalf("soak = %v, want 12h", got)
	}
	t.Setenv("PAIRFOB_AUTO_UPDATE_SOAK", "not-a-duration")
	if got := durationEnv("PAIRFOB_AUTO_UPDATE_SOAK", 12*time.Hour); got != 12*time.Hour {
		t.Fatalf("soak = %v, want 12h", got)
	}
	t.Setenv("PAIRFOB_AUTO_UPDATE_SOAK", "90m")
	if got := durationEnv("PAIRFOB_AUTO_UPDATE_SOAK", 12*time.Hour); got != 90*time.Minute {
		t.Fatalf("soak = %v, want 90m", got)
	}
}
