package remotedesktop

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type LocalHost struct{ Dir string }

// The legacy view/control strings required a fresh local approval for every
// connection. Only a decision made for unattended access grants that access.
type desktopGrant struct {
	Standby bool   `json:"standby,omitempty"`
	Version int    `json:"version"`
	ID      string `json:"id"`
	Mode    string `json:"mode"`
	Display string `json:"display,omitempty"`
}

func readDecision(raw []byte) desktopGrant {
	var g desktopGrant
	if json.Unmarshal(raw, &g) != nil || g.Version != 2 || g.ID == "" {
		return desktopGrant{}
	}
	switch g.Mode {
	case "off":
		return g
	case "view", "control":
		if g.Display != "" {
			return g
		}
	}
	return desktopGrant{}
}

func (h LocalHost) read() ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(h.Dir, "desktop-access"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return raw, err
}

// Supported reports whether this host platform supports local remote desktop setup.
func Supported() bool { return nativeAvailable() }

func (h LocalHost) Policy() Policy {
	if !nativeAvailable() {
		return Policy{}
	}
	raw, err := h.read()
	if err != nil {
		return Policy{Supported: true}
	}
	g := readDecision(raw)
	if g.Mode != "view" && g.Mode != "control" {
		return Policy{Supported: true}
	}
	return Policy{Supported: true, View: true, Control: g.Mode == "control", Display: g.Display, GrantID: g.ID}
}

// Compare only at commit. A disable can take effect while the local setup UI is open.
func (h LocalHost) save(previous []byte, unconditional bool, mode, display string) error {
	g := desktopGrant{Version: 2, ID: rand.Text(), Mode: mode, Display: display}
	if mode != "off" {
		g.Standby = readDecision(previous).Standby
	}
	return h.commit(previous, unconditional, g)
}

func (h LocalHost) commit(previous []byte, unconditional bool, g desktopGrant) error {
	if err := os.MkdirAll(h.Dir, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(h.Dir, "desktop-access.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	if !unconditional {
		raw, err := h.read()
		if err != nil {
			return err
		}
		if !bytes.Equal(raw, previous) {
			return errors.New("desktop setting changed during setup")
		}
	}
	f, err := os.CreateTemp(h.Dir, ".desktop-access-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	err = json.NewEncoder(f).Encode(g)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), filepath.Join(h.Dir, "desktop-access"))
}

func (h LocalHost) Disable() error { return h.save(nil, true, "off", "") }

type setupResult struct {
	Mode           string
	Display        string
	Screen         bool
	Accessibility  bool
	Unlocked       bool
	DisplayPresent bool
	DisplayAwake   bool
	Error          string
}

func queryNative(mode, display string) (setupResult, error) {
	var r setupResult
	exe, err := os.Executable()
	if err != nil {
		return r, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	data, err := exec.CommandContext(ctx, exe, "__desktop_setup", mode, display).Output()
	if err != nil {
		return r, fmt.Errorf("desktop setup: %w", err)
	}
	if err = json.Unmarshal(data, &r); err != nil {
		return r, err
	}
	if r.Error != "" {
		return r, errors.New(r.Error)
	}
	return r, nil
}

var setupDialog sync.Mutex

func (h LocalHost) Configure(mode string, direct bool) (string, error) {
	if !nativeAvailable() {
		return "", ErrUnavailable
	}
	return h.configure(mode, direct, queryNative)
}

func (h LocalHost) configure(mode string, direct bool, query func(string, string) (setupResult, error)) (string, error) {
	switch mode {
	case "offer", "setup", "enable", "enable-control", "status", "standby-on", "standby-off":
	default:
		return "", errors.New("unknown desktop setting")
	}
	if mode != "status" {
		if !setupDialog.TryLock() {
			return "", errors.New("desktop setup already open on the Mac")
		}
		defer setupDialog.Unlock()
	}
	raw, err := h.read()
	if err != nil {
		return "", err
	}
	g := readDecision(raw)
	if mode == "standby-on" || mode == "standby-off" {
		if g.Mode != "view" && g.Mode != "control" {
			return "", errors.New("enable desktop access first")
		}
		g.Standby = mode == "standby-on"
		if g.Standby && !direct {
			return "", errors.New("enable direct P2P before enabling standby")
		}
		return standbyMessage(g.Standby), h.commit(raw, false, g)
	}
	// The installer respects both a prior grant and an explicit decision to leave sharing off.
	if mode == "offer" && g.ID != "" {
		return "Desktop setup already completed.", nil
	}
	if mode == "status" && (g.ID == "" || g.Mode == "off") {
		return "Unattended desktop: off", nil
	}
	action := mode
	if mode == "offer" {
		action = "setup"
	}
	result, err := query(action, g.Display)
	if err != nil {
		return "", err
	}
	if mode != "status" {
		if result.Mode == "skip" {
			if mode == "offer" {
				err = h.save(raw, false, "off", "")
			}
			return "Desktop setup skipped.", err
		}
		if (result.Mode != "view" && result.Mode != "control") || result.Display == "" ||
			(mode == "enable" && result.Mode != "view") || (mode == "enable-control" && result.Mode != "control") {
			return "", errors.New("invalid local desktop decision")
		}
		if err = h.save(raw, false, result.Mode, result.Display); err != nil {
			return "", err
		}
		g.Mode = result.Mode
	}
	message := fmt.Sprintf("Unattended desktop: %s\n%s", g.Mode, standbyMessage(g.Standby))
	if !result.Screen {
		message += "\nFinish granting Screen Recording to Pairfob in System Settings."
	}
	if g.Mode == "control" && !result.Accessibility {
		message += "\nFinish granting Accessibility to Pairfob in System Settings."
	}
	if !direct {
		message += "\nDirect P2P is disabled on this daemon."
	}
	if !result.Unlocked {
		message += "\nThe Mac must be logged in, awake and unlocked."
	}
	if !result.DisplayAwake {
		if result.DisplayPresent {
			message += "\nThe selected display is asleep. Opening the desktop will request a display wake after permission checks."
		} else {
			message += "\nThe selected display is unavailable."
		}
	}
	if direct && result.Unlocked && result.DisplayAwake && result.Screen && (g.Mode != "control" || result.Accessibility) {
		message += "\nLocal desktop checks passed. The phone still needs a direct P2P connection."
	}
	return message, nil
}
