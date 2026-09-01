package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

type health struct {
	Version    string
	Running    bool
	Phones     int
	HerdrOK    bool
	HerdrNote  string
	Enrolled   bool
	Origin     string
	OriginNote string
	P2P        bool
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
	h := health{Version: version, Running: daemonIsLive(sock), P2P: getenv("PAIRFOB_P2P", "1") != "0"}
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
		if live, liveErr := loadPhones(sock); liveErr == nil {
			h.Phones = len(live)
		}
	}
	rt, _, rtErr := runtime.Open(false, getenv("PAIRFOB_MULTI_SESSION", "") == "1")
	if rtErr == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, rtErr = rt.Describe(ctx, runtime.DefaultSession())
		cancel()
	}
	if rtErr == nil {
		h.HerdrOK = true
		h.HerdrNote = "on"
	} else {
		h.HerdrNote = "off — open Herdr on this computer"
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
	fmt.Fprintf(w, "  Running     %s\n", yesNo(h.Running, "yes", "no — it starts at login after install"))
	fmt.Fprintf(w, "  Paired      %d\n", h.Phones)
	fmt.Fprintf(w, "  Herdr       %s\n", h.HerdrNote)
	fmt.Fprintf(w, "  P2P         %s\n", yesNo(h.P2P, "on", "off — this computer is relay-only"))
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
		fmt.Fprintln(w, "Herdr is off. Open it on this computer.")
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
