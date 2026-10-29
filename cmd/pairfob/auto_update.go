package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pairfob/internal/audit"
	"pairfob/internal/daemon"
)

// autoUpdateNote is the observation persisted between checks so a release has
// to stay current for the whole soak window before the daemon installs it.
type autoUpdateNote struct {
	Target    string `json:"target"`
	FirstSeen int64  `json:"first_seen"`          // unix seconds
	Attempted string `json:"attempted,omitempty"` // target an install was started for
}

// autoUpdateStep is the soak decision as a pure function over the stored note
// and the clock. It returns the note to persist and whether to start an
// install now.
func autoUpdateStep(note autoUpdateNote, now time.Time, current, target string, soak time.Duration) (autoUpdateNote, bool) {
	if target == "" || !releaseVersion.MatchString(target) || !newerVersion(target, current) {
		return autoUpdateNote{}, false
	}
	if note.Target != target {
		return autoUpdateNote{Target: target, FirstSeen: now.Unix()}, false
	}
	if note.Attempted == target {
		return note, false
	}
	if now.Sub(time.Unix(note.FirstSeen, 0)) < soak {
		return note, false
	}
	return note, true
}

// autoUpdater polls the release channel and installs a patch release after its
// soak window while the daemon is idle. The DaemonUpdate RPC keeps its own
// manual path.
type autoUpdater struct {
	u       *remoteUpdater
	dir     string
	soak    time.Duration
	every   time.Duration
	enabled bool
	minorOK bool
	idle    func(time.Duration) bool
	now     func() time.Time
	fetch   func(context.Context) (string, error)
	audit   func(op string, fields map[string]any)
	logf    func(string, ...any)
}

func newAutoUpdater(engine *daemon.Engine, u *remoteUpdater, dir string, logger *audit.Logger) *autoUpdater {
	return &autoUpdater{
		u:       u,
		dir:     dir,
		soak:    durationEnv("PAIRFOB_AUTO_UPDATE_SOAK", 12*time.Hour),
		every:   durationEnv("PAIRFOB_AUTO_UPDATE_CHECK", 6*time.Hour),
		enabled: getenv("PAIRFOB_AUTO_UPDATE", "1") != "0",
		now:     time.Now,
		idle:    func(window time.Duration) bool { return engine.IdleSince() >= window },
		fetch:   func(ctx context.Context) (string, error) { return fetchDownloadText(u.base+"/VERSION", 4096) },
		audit:   logger.Event,
		logf:    log.Printf,
	}
}

// durationEnv reads a Go duration, falling back to the default when the value
// is unparsable or shorter than one minute.
func durationEnv(key string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(getenv(key, fallback.String()))
	if err != nil || value < time.Minute {
		return fallback
	}
	return value
}

// Run checks once after a two-minute settle, then on the configured interval
// until ctx is cancelled.
func (a *autoUpdater) Run(ctx context.Context) {
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := a.tick(ctx); err != nil {
				a.logf("daemon_update_auto_check: %v", err)
			}
			timer.Reset(a.every)
		}
	}
}

func (a *autoUpdater) tick(ctx context.Context) error {
	if !a.enabled || !a.u.available {
		return nil
	}
	switch a.u.Status().Phase {
	case "downloading", "restarting", "verifying":
		return nil
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	target, err := a.fetch(fetchCtx)
	cancel()
	if err != nil {
		return nil
	}
	target = strings.TrimSpace(target)
	if !a.minorOK && !strings.HasPrefix(strings.TrimPrefix(target, "v"), majorMinor(version)+".") {
		return nil
	}
	note := a.loadNote()
	next, start := autoUpdateStep(note, a.now(), version, target, a.soak)
	if next != note {
		if err := a.persistNote(next); err != nil {
			return err
		}
	}
	if !start {
		return nil
	}
	if !a.idle(60 * time.Second) {
		return nil
	}
	id, err := autoUpdateOperationID()
	if err != nil {
		return err
	}
	// Record the attempt before starting, so a failed download or a rollback
	// after a restart cannot turn into a loop against the same release.
	next.Attempted = target
	if err := a.persistNote(next); err != nil {
		return err
	}
	if _, err := a.u.Start(id, target); err != nil {
		a.logf("daemon_update_auto %s: %v", target, err)
		return nil
	}
	a.audit("daemon_update_auto", map[string]any{"target": target, "operation_id": id})
	return nil
}

func (a *autoUpdater) notePath() string { return filepath.Join(a.dir, "daemon-auto-update.json") }

func (a *autoUpdater) loadNote() autoUpdateNote {
	data, err := os.ReadFile(a.notePath())
	if err != nil {
		return autoUpdateNote{}
	}
	var note autoUpdateNote
	if json.Unmarshal(data, &note) != nil {
		return autoUpdateNote{}
	}
	return note
}

func (a *autoUpdater) persistNote(note autoUpdateNote) error {
	data, err := json.Marshal(note)
	if err != nil {
		return err
	}
	return writeUpdateJournal(a.notePath(), data)
}

// majorMinor returns the "major.minor" prefix used for the patch-only filter,
// or an empty string when the version is not dotted.
func majorMinor(v string) string {
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) < 2 {
		return ""
	}
	return parts[0] + "." + parts[1]
}

func autoUpdateOperationID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "op_" + base64.RawURLEncoding.EncodeToString(b), nil
}
