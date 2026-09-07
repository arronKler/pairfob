package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"pairfob/internal/runtime"
)

func setupCommand(args []string) error {
	install, nonInteractive := false, false
	for _, arg := range args {
		switch arg {
		case "--install-herdr":
			install = true
		case "--non-interactive":
			nonInteractive = true
		default:
			return errors.New("usage: pairfob setup [--install-herdr] [--non-interactive]")
		}
	}
	rt, _, err := runtime.Open(false, getenv("PAIRFOB_MULTI_SESSION", "") == "1")
	if err != nil {
		return err
	}
	h := rt.(*runtime.Herdr)
	return setupHerdr(h, install, herdrSetupActions{
		autostart: herdrAutostartEnabled(false, h.Multi),
		confirm:   func() bool { return !nonInteractive && confirmHerdrInstall() },
		install:   installHerdr,
	}, os.Stdout)
}

type herdrSetupRuntime interface {
	CheckInstallation(context.Context) runtime.HerdrInstallation
	EnsureServer(context.Context) (runtime.HerdrServerAvailability, error)
}

type herdrSetupActions struct {
	autostart bool
	confirm   func() bool
	install   func() error
}

func setupHerdr(h herdrSetupRuntime, install bool, actions herdrSetupActions, out io.Writer) error {
	check := checkHerdrInstallation(h)
	if check.State == "missing" {
		if !install && actions.confirm != nil {
			install = actions.confirm()
		}
		if !install {
			return errors.New("setup incomplete: Herdr is not installed. Run pairfob setup --install-herdr, or install it from https://herdr.dev")
		}
		fmt.Fprintf(out, "Installing Herdr %s into ~/.local/bin (SHA-256 verified)…\n", bundledHerdrVersion)
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
		return "not installed — run pairfob setup --install-herdr"
	case "stopped":
		return "installed but not running — run pairfob setup"
	case "incompatible":
		return fmt.Sprintf("incompatible server (protocol %d) — upgrade Herdr and restart it when your sessions can be interrupted", check.Descriptor.Protocol)
	default:
		return "unavailable — check HERDR_BIN, executable permissions and the configured Herdr socket; run herdr status for details"
	}
}

// The install script may occupy stdin (curl | sh), so consent uses the terminal.
func confirmHerdrInstall() bool {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return false
	}
	defer tty.Close()
	fmt.Fprintf(tty, "Herdr is required to run sessions. Install Herdr %s into ~/.local/bin? [y/N] ", bundledHerdrVersion)
	answer, err := bufio.NewReader(tty).ReadString('\n')
	return err == nil && (strings.EqualFold(strings.TrimSpace(answer), "y") || strings.EqualFold(strings.TrimSpace(answer), "yes"))
}
