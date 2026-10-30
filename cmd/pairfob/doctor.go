package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

type health struct {
	Version          string
	RunningVersion   string
	RunningPID       int
	ProcessNote      string
	Running          bool
	Recovery         serviceRecoveryHint
	Phones           int
	RuntimeKind      string
	RuntimeCommand   string
	RuntimeOK        bool
	RuntimeNote      string
	RuntimeVersion   string
	RuntimeProtocol  int
	RuntimeTerminals int
	Enrolled         bool
	Origin           string
	OriginNote       string
	P2P              *bool
}

func doctorCommand(sock string) error {
	h, err := gatherHealth(sock)
	if err != nil {
		return err
	}
	writeDoctor(os.Stdout, h)
	writePrivacyDoctor(os.Stdout, sock)
	if h.RuntimeKind == runtime.RuntimeKindHerdr {
		writeHerdrMaintenance(os.Stdout)
	}
	if !h.Running || !h.RuntimeOK {
		return errDoctor
	}
	return nil
}

var errDoctor = fmt.Errorf("not ready")

func gatherHealth(sock string) (health, error) {
	configuredP2P := getenv("PAIRFOB_P2P", "1") != "0"
	h := health{
		Version: version, Running: daemonIsLive(sock), P2P: &configuredP2P,
		RuntimeTerminals: -1,
	}
	if !h.Running {
		h.Recovery = localServiceHint()
	}
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
	gatherRuntimeHealth(&h)
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

func gatherRuntimeHealth(h *health) {
	devFake := os.Getenv("PAIRFOB_DEV_FAKE_RUNTIME") == "1"
	selection, err := runtime.SelectRuntime(devFake)
	if err != nil {
		h.RuntimeKind = runtime.RuntimeKindHerdr
		h.RuntimeNote = "unavailable — no Herdr or herdr-core runtime found; run pairfob setup"
		return
	}
	h.RuntimeKind = selection.Kind
	h.RuntimeCommand = selection.Command
	switch selection.Kind {
	case runtime.RuntimeKindCore:
		gatherCoreHealth(h, selection)
	case runtime.RuntimeKindHerdr:
		gatherHerdrHealth(h)
	case runtime.RuntimeKindFake:
		h.RuntimeOK = true
		h.RuntimeNote = "development fake runtime"
	default:
		h.RuntimeNote = "unavailable — unknown runtime"
	}
}

func gatherHerdrHealth(h *health) {
	rt, _, err := runtime.Open(false, herdrMultiSessionEnabled())
	if err != nil {
		h.RuntimeNote = "unavailable — check the configured Herdr socket"
		return
	}
	check := checkHerdrInstallation(rt.(*runtime.Herdr))
	h.RuntimeVersion = check.Descriptor.Version
	h.RuntimeProtocol = check.Descriptor.Protocol
	h.RuntimeOK = check.State == "ready"
	if !h.RuntimeOK {
		h.RuntimeNote = herdrInstallationNote(check)
		return
	}
	h.RuntimeTerminals = runtimeTerminalCount(rt)
}

func gatherCoreHealth(h *health, selection runtime.RuntimeSelection) {
	core := runtime.NewCore(selection.Command)
	defer core.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	descriptor, err := core.Describe(ctx, runtime.DefaultSession())
	cancel()
	if err != nil {
		h.RuntimeNote = "unavailable — herdr-core did not answer; check hc and run pairfob runtime"
		return
	}
	h.RuntimeVersion = descriptor.Version
	h.RuntimeProtocol = descriptor.Protocol
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	view, err := core.Observe(ctx, runtime.DefaultSession(), runtime.SnapshotQuery{})
	cancel()
	if err != nil {
		h.RuntimeNote = "terminals could not be read: " + err.Error()
		return
	}
	snapshot, ok := view.(runtime.SnapshotView)
	if !ok {
		h.RuntimeNote = "terminals could not be read"
		return
	}
	h.RuntimeOK = true
	h.RuntimeTerminals = len(snapshot.Snapshot.Panes)
}

func runtimeTerminalCount(rt runtime.Runtime) int {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	view, err := rt.Observe(ctx, runtime.DefaultSession(), runtime.SnapshotQuery{})
	if err != nil {
		return -1
	}
	snapshot, ok := view.(runtime.SnapshotView)
	if !ok {
		return -1
	}
	return len(snapshot.Snapshot.Panes)
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
	fmt.Fprintf(w, "  Running     %s\n", yesNo(h.Running, "yes", "no — "+h.Recovery.Note))
	fmt.Fprintf(w, "  Paired      %d\n", h.Phones)
	fmt.Fprintf(w, "  Runtime     %s\n", runtimeDoctorLine(h))
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
		fmt.Fprintln(w, "\n"+h.Recovery.advice())
	}
}

// runtimeDoctorLine names the selected runtime, its version and protocol when
// known, and how many terminals the phone would see.
func runtimeDoctorLine(h health) string {
	kind := h.RuntimeKind
	if kind == "" {
		kind = "unknown"
	}
	line := kind
	parts := make([]string, 0, 3)
	if h.RuntimeVersion != "" {
		parts = append(parts, h.RuntimeVersion)
	}
	if h.RuntimeProtocol > 0 {
		parts = append(parts, fmt.Sprintf("protocol %d", h.RuntimeProtocol))
	}
	if h.RuntimeOK && h.RuntimeTerminals >= 0 {
		parts = append(parts, terminalCount(h.RuntimeTerminals))
	}
	if len(parts) > 0 {
		line += " " + strings.Join(parts, ", ")
	}
	if h.RuntimeNote != "" {
		line += " — " + h.RuntimeNote
	}
	return line
}

func terminalCount(n int) string {
	if n == 1 {
		return "1 terminal"
	}
	return fmt.Sprintf("%d terminals", n)
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
	if h.RuntimeOK {
		if h.RuntimeKind == runtime.RuntimeKindHerdr {
			fmt.Fprintln(w, "Herdr is on.")
		} else {
			fmt.Fprintln(w, h.RuntimeKind+" is on.")
		}
	} else {
		fmt.Fprintln(w, h.RuntimeKind+": "+h.RuntimeNote)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  pairfob pair     pair a device")
	fmt.Fprintln(w, "  pairfob list     what's paired")
	fmt.Fprintln(w, "  pairfob doctor   full check")
	if h.RuntimeKind == runtime.RuntimeKindCore {
		fmt.Fprintf(w, "  %s run --bg claude    start a terminal\n", coreTerminalCommand(h.RuntimeCommand))
	} else {
		fmt.Fprintf(w, "  %s    local terminal\n", herdrTerminalCommand())
	}
	fmt.Fprintln(w, "  Browser: https://pairfob.com/pair (this computer, a phone or a tablet)")
	return nil
}

func coreTerminalCommand(command string) string {
	if command == "" {
		command = "hc"
	}
	if strings.ContainsRune(command, '/') {
		return shellQuote(command)
	}
	return command
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
