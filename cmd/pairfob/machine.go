package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

	"pairfob/internal/pairingqr"
	"pairfob/internal/runtime"
)

const machineUsage = "usage: pairfob machine list\n       pairfob machine link NAME [--install]"

// machineLinker pairs a device with another computer the local runtime already
// reaches over SSH. That computer keeps its own Pairfob identity and keys; this
// one only starts Pairfob there and relays its one-use pairing offer.
type machineLinker struct {
	runtime runtime.Runtime
	remote  machineRemote
	install machineInstall
	in      io.Reader
	out     io.Writer
	// confirm decides whether Pairfob may be installed on the machine.
	confirm func(label string) (bool, error)
}

func machineCommand(args []string) error {
	if len(args) == 0 {
		return errors.New(machineUsage)
	}
	linker := machineLinker{
		runtime: runtime.NewHerdr(runtime.DefaultSocket()),
		install: machineInstallFromEnv(),
		in:      os.Stdin, out: os.Stdout,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return errors.New(machineUsage)
		}
		return linker.list(ctx)
	case "link":
		name, install := "", false
		for _, arg := range args[1:] {
			switch {
			case arg == "--install":
				install = true
			case name == "" && !strings.HasPrefix(arg, "-"):
				name = arg
			default:
				return errors.New(machineUsage)
			}
		}
		if name == "" {
			return errors.New(machineUsage)
		}
		linker.confirm = func(label string) (bool, error) {
			if install {
				return true, nil
			}
			if !writerIsTTY(os.Stdout) {
				return false, nil
			}
			return askInstallOnMachine(linker.in, linker.out, label)
		}
		return linker.link(ctx, name)
	default:
		return errors.New(machineUsage)
	}
}

// Only a development setup overrides these; a remote install otherwise uses
// the official download site and origin.
func machineInstallFromEnv() machineInstall {
	return machineInstall{
		DownloadBase: strings.TrimRight(strings.TrimSpace(os.Getenv("PAIRFOB_DOWNLOAD_BASE")), "/"),
		Origin:       strings.TrimSpace(os.Getenv("PAIRFOB_ORIGIN")),
	}
}

func askInstallOnMachine(in io.Reader, out io.Writer, label string) (bool, error) {
	if _, err := fmt.Fprintf(out, "Install Pairfob on %s? [y/N] ", label); err != nil {
		return false, err
	}
	answer, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && answer == "" {
		return false, nil
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes", nil
}

func (l machineLinker) machines(ctx context.Context) ([]runtime.Machine, error) {
	view, err := l.runtime.Observe(ctx, runtime.DefaultSession(), runtime.MachineListQuery{})
	if err != nil {
		return nil, err
	}
	list, ok := view.(runtime.MachineListView)
	if !ok {
		return nil, errors.New("unexpected machine list")
	}
	return list.Machines, nil
}

func (l machineLinker) list(ctx context.Context) error {
	machines, err := l.machines(ctx)
	if err != nil {
		return err
	}
	if len(machines) == 0 {
		_, err := fmt.Fprintln(l.out, "Herdr has no saved SSH machines. Add one: herdr machine add HOST")
		return err
	}
	for _, machine := range machines {
		state := ""
		if !machine.Enabled {
			state = "  (disabled in Herdr)"
		}
		if _, err := fmt.Fprintf(l.out, "  %s%s\n", machineLabel(machine), state); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintln(l.out, "\nAdd one to your paired device: pairfob machine link NAME")
	return err
}

func machineLabel(machine runtime.Machine) string {
	if machine.Label != "" {
		return machine.Label
	}
	return machine.ID
}

// selectMachine accepts a profile ID or a label that names exactly one machine.
func selectMachine(machines []runtime.Machine, name string) (runtime.Machine, error) {
	var byLabel []runtime.Machine
	for _, machine := range machines {
		if machine.ID == name {
			return machine, nil
		}
		if machine.Label == name {
			byLabel = append(byLabel, machine)
		}
	}
	switch len(byLabel) {
	case 1:
		return byLabel[0], nil
	case 0:
		return runtime.Machine{}, fmt.Errorf("Herdr has no saved machine named %q. See: pairfob machine list", name)
	default:
		return runtime.Machine{}, fmt.Errorf("more than one machine is named %q; use its ID from herdr machine list", name)
	}
}

// machineLinkError names why a machine could not be linked, for callers that
// report a code instead of this computer's operator copy.
type machineLinkError struct {
	Code string
	Err  error
}

func (e *machineLinkError) Error() string { return e.Err.Error() }
func (e *machineLinkError) Unwrap() error { return e.Err }

func linkErrorf(code, format string, args ...any) error {
	return &machineLinkError{Code: code, Err: fmt.Errorf(format, args...)}
}

// ready leaves the machine with a running Pairfob that can hand out an offer,
// installing it only after confirm agrees.
func (l machineLinker) ready(ctx context.Context, machine runtime.Machine) error {
	label := machineLabel(machine)
	if !machine.Enabled {
		return linkErrorf("disabled", "%s is disabled in Herdr. Enable it: herdr machine enable %s", label, machine.ID)
	}
	if !machineSessionSupported(machine) {
		return linkErrorf("session_unsupported", "%s uses the Herdr session %q; only the default session can be added for now", label, machine.Session)
	}
	probe, err := l.remote.probe(ctx, machine.Target)
	if err != nil {
		return machineReachError(label, machine, err)
	}
	if !probe.supported() {
		return linkErrorf("unsupported", "%s runs %s; Pairfob supports Linux and macOS", label, probe.OS)
	}
	if probe.needsInstall() {
		ok, err := l.confirm(label)
		if err != nil {
			return err
		}
		if !ok {
			return linkErrorf("needs_install", "Pairfob needs to be installed on %s. Run again with --install.", label)
		}
		if _, err := fmt.Fprintf(l.out, "Installing Pairfob on %s…\n", label); err != nil {
			return err
		}
		if err := l.remote.install(ctx, machine.Target, l.install, l.out); err != nil {
			if errors.Is(err, errMachineUnreachable) {
				return machineReachError(label, machine, err)
			}
			return linkErrorf("install_failed", "installing Pairfob on %s did not finish: %w", label, err)
		}
		if probe, err = l.remote.probe(ctx, machine.Target); err != nil {
			return machineReachError(label, machine, err)
		}
		if probe.needsInstall() {
			return linkErrorf("install_failed", "Pairfob on %s is still too old to be added from here", label)
		}
	}
	if !probe.Running {
		return linkErrorf("not_running", "Pairfob is installed on %s but is not running. Run pairfob doctor there.", label)
	}
	return nil
}

func machineSessionSupported(machine runtime.Machine) bool {
	return machine.Session == "" || machine.Session == "default"
}

func machineReachError(label string, machine runtime.Machine, err error) error {
	if errors.Is(err, errMachineUnreachable) {
		return linkErrorf("unreachable", "could not reach %s over SSH. Check: ssh %s\n%w", label, machine.Target, err)
	}
	return linkErrorf("internal", "%s: %w", label, err)
}

func (l machineLinker) link(ctx context.Context, name string) error {
	machines, err := l.machines(ctx)
	if err != nil {
		return err
	}
	machine, err := selectMachine(machines, name)
	if err != nil {
		return err
	}
	if err := l.ready(ctx, machine); err != nil {
		return err
	}
	label := machineLabel(machine)
	offer, err := l.remote.offer(ctx, machine.Target)
	if err != nil {
		return machineReachError(label, machine, err)
	}
	defer offer.Close()
	if _, err := fmt.Fprintf(l.out, "Pairing with %s:\n\n", label); err != nil {
		return err
	}
	if err := pairingqr.Print(l.out, pairingqr.Offer{
		Code: offer.Offer.Code, Ref: offer.Offer.Ref, URL: offer.Offer.URL, Loc: offer.Offer.Loc,
	}, time.Until(*offer.Offer.ExpiresAt)); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(l.out, "Waiting to pair…  Ctrl-C to cancel"); err != nil {
		return err
	}
	if err := offer.Wait(); err != nil {
		if ctx.Err() != nil {
			return errors.New("pairing cancelled")
		}
		return fmt.Errorf("pairing with %s did not finish: %w", label, err)
	}
	_, err = fmt.Fprintf(l.out, "Paired. %s is now on that device.\n", label)
	return err
}
