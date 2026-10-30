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

	"pairfob/internal/runtime"
)

const runtimeUsage = "usage: pairfob runtime [--json]"

// runtimeStatus is the machine-readable result of `pairfob runtime --json`.
// Version and Protocol stay empty or zero when the selected runtime cannot be
// reached; the selection itself is still valid.
type runtimeStatus struct {
	Kind     string `json:"kind"`
	Source   string `json:"source"`
	Command  string `json:"command"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

func runtimeCommand(args []string) error {
	return writeRuntimeCommand(os.Stdout, args)
}

func writeRuntimeCommand(w io.Writer, args []string) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		case "-h", "--help":
			fmt.Fprintln(w, runtimeUsage)
			return nil
		default:
			return errors.New(runtimeUsage)
		}
	}
	devFake := os.Getenv("PAIRFOB_DEV_FAKE_RUNTIME") == "1"
	selection, err := runtime.SelectRuntime(devFake)
	if err != nil {
		return err
	}
	status := runtimeStatus{Kind: selection.Kind, Source: selection.Source, Command: selection.Command}
	status.Version, status.Protocol = probeRuntime(selection)
	if jsonOutput {
		return json.NewEncoder(w).Encode(status)
	}
	line := status.Kind + "  " + status.Source
	if status.Version != "" {
		line += fmt.Sprintf("  (%s, protocol %d)", status.Version, status.Protocol)
	}
	fmt.Fprintln(w, line)
	return nil
}

// probeRuntime reads the runtime's own descriptor. A runtime that is selected
// but not running is still a valid answer, so its error stays out of the exit
// status; setup and doctor decide whether it is ready.
func probeRuntime(selection runtime.RuntimeSelection) (string, int) {
	rt, err := openSelectedRuntime(selection)
	if err != nil {
		return "", 0
	}
	if core, ok := rt.(*runtime.Core); ok {
		defer core.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	descriptor, err := rt.Describe(ctx, runtime.DefaultSession())
	if err != nil {
		return "", 0
	}
	return descriptor.Version, descriptor.Protocol
}

func openSelectedRuntime(selection runtime.RuntimeSelection) (runtime.Runtime, error) {
	switch selection.Kind {
	case runtime.RuntimeKindHerdr:
		rt, _, err := runtime.Open(false, herdrMultiSessionEnabled())
		return rt, err
	case runtime.RuntimeKindCore:
		return runtime.NewCore(selection.Command), nil
	case runtime.RuntimeKindFake:
		return runtime.NewFake(), nil
	default:
		return nil, fmt.Errorf("unknown runtime %q", strings.TrimSpace(selection.Kind))
	}
}
