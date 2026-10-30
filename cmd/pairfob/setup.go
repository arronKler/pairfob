package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"pairfob/internal/runtime"
)

const setupUsage = `usage: pairfob setup [--install-herdr | --no-install-herdr] [--non-interactive] [--update-herdr [--restart-herdr]]

Herdr is prepared by default. With PAIRFOB_RUNTIME=core, setup only checks the
herdr-core client (hc); Herdr flags are rejected.`

type setupOptions struct {
	install        bool
	installChosen  bool
	nonInteractive bool
	update         bool
	restart        bool
}

func parseSetupOptions(args []string) (setupOptions, error) {
	o := setupOptions{install: true}
	yes, no := false, false
	for _, arg := range args {
		switch arg {
		case "--install-herdr":
			yes = true
			o.installChosen = true
		case "--no-install-herdr":
			no = true
			o.install = false
			o.installChosen = true
		case "--non-interactive":
			o.nonInteractive = true
		case "--update-herdr":
			o.update = true
		case "--restart-herdr":
			o.restart = true
		default:
			return o, errors.New(setupUsage)
		}
	}
	if yes && no || o.restart && (!o.update || o.nonInteractive) || o.update && (yes || no) {
		return o, errors.New(setupUsage)
	}
	return o, nil
}

func setupCommand(args []string) error {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Println(setupUsage)
		return nil
	}
	o, err := parseSetupOptions(args)
	if err != nil {
		return err
	}
	selection, auto, err := setupRuntimeSelection()
	if err != nil {
		return err
	}
	if selection.Kind == runtime.RuntimeKindCore {
		if flags := o.herdrOnlyFlags(); len(flags) > 0 {
			return fmt.Errorf("pairfob setup: %s only applies to the Herdr runtime, and this computer uses herdr-core; set PAIRFOB_RUNTIME=herdr and run pairfob setup to use Herdr", strings.Join(flags, ", "))
		}
		layout, err := currentServiceLayout()
		if err != nil {
			return err
		}
		return withServiceLock(layout, func() error { return setupCore(selection, auto) })
	}
	if o.update {
		return updateHerdrCommand(o.restart)
	}
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	return withServiceLock(layout, func() error { return setupLocked(o) })
}

// setupRuntimeSelection lets `pairfob setup` install Herdr when auto detection
// finds nothing, which is the historical behavior. An explicit runtime fails
// closed instead of preparing a different runtime than the one requested.
func setupRuntimeSelection() (runtime.RuntimeSelection, bool, error) {
	selection, err := runtime.SelectRuntime(false)
	automatic := runtimeSelectionAutomatic()
	if err == nil {
		return selection, automatic, nil
	}
	if automatic {
		return runtime.RuntimeSelection{
			Kind: runtime.RuntimeKindHerdr, Source: "herdr:" + runtime.DefaultSocket(),
		}, true, nil
	}
	return runtime.RuntimeSelection{}, false, err
}

func runtimeSelectionAutomatic() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv("PAIRFOB_RUNTIME")))
	return value == "" || value == "auto"
}

func (o setupOptions) herdrOnlyFlags() []string {
	var flags []string
	if o.installChosen {
		if o.install {
			flags = append(flags, "--install-herdr")
		} else {
			flags = append(flags, "--no-install-herdr")
		}
	}
	if o.update {
		flags = append(flags, "--update-herdr")
	}
	if o.restart {
		flags = append(flags, "--restart-herdr")
	}
	return flags
}

func setupCore(selection runtime.RuntimeSelection, auto bool) error {
	command := selection.Command
	if command == "" {
		command = runtime.DefaultHC()
	}
	if _, err := exec.LookPath(command); err != nil {
		return fmt.Errorf("setup incomplete: herdr-core client %q is not runnable; install herdr-core (hc), or set PAIRFOB_RUNTIME=herdr to use Herdr", command)
	}
	core := runtime.NewCore(command)
	defer core.Close()
	if auto {
		fmt.Println("Runtime: herdr-core (auto-selected)")
	}
	describeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	descriptor, err := core.Describe(describeCtx, runtime.DefaultSession())
	cancel()
	if err != nil {
		return fmt.Errorf("setup incomplete: herdr-core did not answer: %w; check hc, or set PAIRFOB_RUNTIME=herdr to use Herdr", err)
	}
	observeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	view, err := core.Observe(observeCtx, runtime.DefaultSession(), runtime.SnapshotQuery{})
	cancel()
	if err != nil {
		return fmt.Errorf("setup incomplete: herdr-core terminals could not be read: %w", err)
	}
	snapshot, ok := view.(runtime.SnapshotView)
	if !ok {
		return errors.New("setup incomplete: herdr-core returned an unexpected snapshot")
	}
	fmt.Printf("herdr-core: ready (%s, protocol %d, %s)\n", descriptor.Version, descriptor.Protocol, terminalCount(len(snapshot.Snapshot.Panes)))
	return nil
}

func setupLocked(o setupOptions) error {
	f, err := localHerdrFiles()
	if err != nil {
		return err
	}
	lock, err := f.lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = f.recoverInstall(); err != nil {
		return err
	}
	if err = f.recoverHerdrUpdate(); err != nil {
		return err
	}
	rt, _, err := runtime.Open(false, herdrMultiSessionEnabled())
	if err != nil {
		return err
	}
	h := rt.(*runtime.Herdr)
	if err = setupHerdr(h, o.install, herdrSetupActions{
		autostart: herdrAutostartEnabled(false),
		install:   func() error { return installHerdrLocked(f) },
	}, os.Stdout); err != nil {
		return err
	}
	return f.finishVerifiedUpdate(checkHerdrInstallation(h).Descriptor.Version)
}

type herdrSetupRuntime interface {
	CheckInstallation(context.Context) runtime.HerdrInstallation
	EnsureServer(context.Context) (runtime.HerdrServerAvailability, error)
}

type herdrSetupActions struct {
	autostart bool
	install   func() error
}

func setupHerdr(h herdrSetupRuntime, install bool, actions herdrSetupActions, out io.Writer) error {
	check := checkHerdrInstallation(h)
	if check.State == "missing" {
		if !install {
			return errors.New("setup incomplete: Herdr is missing and automatic installation was disabled; run pairfob setup to install it")
		}
		fmt.Fprintln(out, "Installing the latest stable Herdr session runtime into ~/.local/bin (SHA-256 verified)…")
		if err := actions.install(); err != nil {
			return fmt.Errorf("setup incomplete: %w", err)
		}
		check = checkHerdrInstallation(h)
	}
	if check.State == "stopped" {
		if !actions.autostart {
			return errors.New("setup incomplete: automatic Herdr startup is disabled; start the configured Herdr server, then run pairfob setup")
		}
		fmt.Fprintln(out, "Starting Herdr and waiting for its API…")
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		_, err := h.EnsureServer(ctx)
		cancel()
		if err != nil {
			return fmt.Errorf("setup incomplete: Herdr failed to start: %w; run pairfob doctor", err)
		}
		check = checkHerdrInstallation(h)
	}
	fmt.Fprintln(out, "Herdr: "+herdrInstallationNote(check))
	if check.State != "ready" {
		return errors.New("setup incomplete; resolve the Herdr diagnosis above, then run pairfob setup")
	}
	return nil
}

func checkHerdrInstallation(h herdrSetupRuntime) runtime.HerdrInstallation {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return h.CheckInstallation(ctx)
}

func herdrInstallationNote(check runtime.HerdrInstallation) string {
	switch check.State {
	case "ready":
		return fmt.Sprintf("ready (%s, protocol %d)", check.Descriptor.Version, check.Descriptor.Protocol)
	case "missing":
		return "not installed — run pairfob setup"
	case "stopped":
		return "installed but not running — run pairfob setup"
	case "incompatible":
		return fmt.Sprintf("incompatible server (protocol %d) — upgrade Herdr and restart it when your sessions can be interrupted", check.Descriptor.Protocol)
	default:
		return "unavailable — check HERDR_BIN, executable permissions and the configured Herdr socket; run herdr status for details"
	}
}
