package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"pairfob/internal/admin"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

type health struct {
	Version        string
	RunningVersion string
	RunningPID     int
	ProcessNote    string
	Running        bool
	Phones         int
	HerdrOK        bool
	HerdrNote      string
	Enrolled       bool
	Origin         string
	OriginNote     string
	P2P            *bool
}

func doctorCommand(sock string) error {
	h, err := gatherHealth(sock)
	if err != nil {
		return err
	}
	writeDoctor(os.Stdout, h)
	if !h.Running || !h.HerdrOK {
		return errDoctor
	}
	return nil
}

var errDoctor = fmt.Errorf("not ready")

func gatherHealth(sock string) (health, error) {
	configuredP2P := getenv("PAIRFOB_P2P", "1") != "0"
	h := health{Version: version, Running: daemonIsLive(sock), P2P: &configuredP2P}
	store, err := state.Open("")
	if err != nil {
		return h, err
	}
	rows, err := store.LoadDevices()
	if err != nil {
		return h, err
	}
	for _, d := range rows {
		if d.RevokedAt == nil {
			h.Phones++
		}
	}
	if h.Running {
		if p, err := inspectLocalProcess(sock); err == nil {
			h.RunningPID = p.peer.PID
			if p.legacy {
				h.ProcessNote = "legacy interface; actual version unknown"
			} else {
				h.RunningVersion = p.info.Version
				if h.Version != p.info.Version {
					h.ProcessNote = "installed and running programs differ; run pairfob service restart"
				}
				if exe, err := resolvedExecutable(); err == nil {
					if hash, err := executableHash(exe); err == nil && hash != p.info.SHA256 {
						h.ProcessNote = "installed and running programs differ; run pairfob service restart"
					}
				}
			}
			p.peer.Close()
		} else {
			h.ProcessNote = "could not verify the running version"
		}
		h.P2P = nil
		if liveP2P, liveErr := loadDaemonP2P(sock); liveErr == nil {
			h.P2P = liveP2P
		}
		if live, liveErr := loadPhones(sock); liveErr == nil {
			h.Phones = len(live)
		}
	}
	rt, _, rtErr := runtime.Open(false, getenv("PAIRFOB_MULTI_SESSION", "") == "1")
	h.HerdrNote = "unavailable — check the configured Herdr socket"
	if rtErr == nil {
		check := checkHerdrInstallation(rt.(*runtime.Herdr))
		h.HerdrOK = check.State == "ready"
		h.HerdrNote = herdrInstallationNote(check)
	}
	stored, relayErr := store.LoadRelay()
	if relayErr != nil {
		h.OriginNote = relayErr.Error()
		return h, nil
	}
	h.Enrolled = stored.ReconnectToken != ""
	env := muxEnvFromProcess(stored)
	plan, inferErr := inferMux(env)
	if inferErr != nil {
		h.OriginNote = inferErr.Error()
		return h, nil
	}
	h.Origin = originHost(plan.Origin)
	if h.Origin == "" && plan.DialURL != "" {
		h.Origin = originHost(originFromWSURL(plan.DialURL))
	}
	if plan.Origin != "" {
		if proto, probeErr := probeOriginProtocol(plan.Origin); probeErr != "" {
			h.OriginNote = probeErr
		} else if proto != 0 && proto != plan.Protocol && plan.Protocol != 0 {
			h.OriginNote = "origin protocol does not match this computer"
		}
	}
	if !h.Enrolled && plan.Protocol == 2 {
		h.OriginNote = "not set up — re-run the installer"
	}
	return h, nil
}

func writeDoctor(w io.Writer, h health) {
	fmt.Fprintf(w, "Pairfob %s\n\n", h.Version)
	fmt.Fprintf(w, "  Installed   %s\n", h.Version)
	if h.Running {
		running := h.RunningVersion
		if running == "" {
			running = "unknown"
		}
		fmt.Fprintf(w, "  Process     %s", running)
		if h.RunningPID > 0 {
			fmt.Fprintf(w, " (PID %d)", h.RunningPID)
		}
		fmt.Fprintln(w)
		if h.ProcessNote != "" {
			fmt.Fprintf(w, "  Notice      %s\n", h.ProcessNote)
		}
	}
	fmt.Fprintf(w, "  Running     %s\n", yesNo(h.Running, "yes", "no — it starts at login after install"))
	fmt.Fprintf(w, "  Paired      %d\n", h.Phones)
	fmt.Fprintf(w, "  Herdr       %s\n", h.HerdrNote)
	p2p := "unknown — restart Pairfob to check"
	if h.P2P != nil {
		p2p = yesNo(*h.P2P, "on", "off — this computer is relay-only")
	}
	fmt.Fprintf(w, "  P2P         %s\n", p2p)
	origin := h.Origin
	if origin == "" {
		origin = "local"
	}
	if note := doctorOriginNote(h.OriginNote); note != "" {
		fmt.Fprintf(w, "  Origin      %s (%s)\n", origin, note)
	} else {
		fmt.Fprintf(w, "  Origin      %s\n", origin)
	}
	if h.Running {
		fmt.Fprintln(w, "\n  pairfob pair     pair a device")
		fmt.Fprintln(w, "  pairfob list     what's paired")
	} else {
		fmt.Fprintln(w, "\nStart it in this terminal with: pairfob")
	}
}

func loadDaemonP2P(sock string) (*bool, error) {
	resp, err := admin.Call(sock, admin.Request{Op: "pair.status"})
	if err != nil {
		return nil, notRunning(err)
	}
	var status admin.Pairing
	if len(resp.Result) == 0 || json.Unmarshal(resp.Result, &status) != nil {
		return nil, errors.New("pairfob returned an invalid status")
	}
	return status.P2P, nil
}

func writeLiveSnapshot(w io.Writer, sock string) error {
	h, err := gatherHealth(sock)
	if err != nil {
		return err
	}
	fmt.Fprintln(w, "Pairfob is running.")
	switch h.Phones {
	case 0:
		fmt.Fprintln(w, "Nothing paired yet.")
	case 1:
		fmt.Fprintln(w, "1 device paired.")
	default:
		fmt.Fprintf(w, "%d devices paired.\n", h.Phones)
	}
	if h.HerdrOK {
		fmt.Fprintln(w, "Herdr is on.")
	} else {
		fmt.Fprintln(w, "Herdr: "+h.HerdrNote)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  pairfob pair     pair a device")
	fmt.Fprintln(w, "  pairfob list     what's paired")
	fmt.Fprintln(w, "  pairfob doctor   full check")
	return nil
}

func yesNo(ok bool, yes, no string) string {
	if ok {
		return yes
	}
	return no
}

func originHost(origin string) string {
	origin = strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://")
	return strings.TrimRight(origin, "/")
}
