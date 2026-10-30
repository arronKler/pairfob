package runtime

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	RuntimeKindHerdr = "herdr"
	RuntimeKindCore  = "herdr-core"
	RuntimeKindFake  = "fake"
)

// RuntimeSelection names the terminal runtime this computer will use. Command
// is the executable the adapter starts; it is empty when no binary is known.
type RuntimeSelection struct {
	Kind    string
	Source  string
	Command string
}

// DefaultHC resolves the herdr-core client binary. The daemon inherits
// HC_SESSION and HC_SOCKET through its environment.
func DefaultHC() string {
	if command := strings.TrimSpace(os.Getenv("PAIRFOB_HC")); command != "" {
		return command
	}
	return "hc"
}

// SelectRuntime resolves PAIRFOB_RUNTIME. An explicit value is authoritative;
// auto prefers Herdr and falls back to a runnable herdr-core client. The
// requested value never silently maps to a different runtime: only auto
// chooses, and only between the two supported runtimes.
func SelectRuntime(devFake bool) (RuntimeSelection, error) {
	if devFake {
		return RuntimeSelection{Kind: RuntimeKindFake, Source: "fake:explicit-dev"}, nil
	}
	configured := strings.ToLower(strings.TrimSpace(os.Getenv("PAIRFOB_RUNTIME")))
	switch configured {
	case "", "auto":
		return selectAvailableRuntime()
	case "herdr":
		return herdrSelection()
	case "core", "herdr-core":
		command := DefaultHC()
		return RuntimeSelection{Kind: RuntimeKindCore, Source: "herdr-core:" + command, Command: command}, nil
	default:
		return RuntimeSelection{}, &Fault{
			Code: CodeInvalid, Operation: "runtime", Outcome: OutcomeNotApplied,
			Retry:       RetryNever,
			SafeMessage: fmt.Sprintf("unknown PAIRFOB_RUNTIME value %q; use herdr, core, or auto", configured),
		}
	}
}

func selectAvailableRuntime() (RuntimeSelection, error) {
	if herdrDetected() {
		return herdrSelection()
	}
	if command, err := exec.LookPath(DefaultHC()); err == nil {
		if absolute, absErr := filepath.Abs(command); absErr == nil {
			command = absolute
		}
		return RuntimeSelection{Kind: RuntimeKindCore, Source: "herdr-core:" + command, Command: command}, nil
	}
	return RuntimeSelection{}, &Fault{
		Code: CodeOffline, Operation: "runtime", Outcome: OutcomeNotApplied,
		Retry: RetryReadSafe,
		SafeMessage: "no terminal runtime found; install Herdr or herdr-core (hc), " +
			"or set PAIRFOB_RUNTIME=herdr|core",
	}
}

// herdrDetected reports whether Herdr is installed or its configured socket
// exists. A stopped Herdr is still the selected runtime; setup can start it.
func herdrDetected() bool {
	if _, err := ResolveHerdrBinary(); err == nil {
		return true
	}
	socket := DefaultSocket()
	if socket == "" {
		return false
	}
	info, err := os.Stat(socket)
	return err == nil && !info.IsDir()
}

func herdrSelection() (RuntimeSelection, error) {
	socket := DefaultSocket()
	if socket == "" {
		return RuntimeSelection{}, &Fault{
			Code: CodeOffline, Operation: "runtime", Outcome: OutcomeNotApplied,
			Retry: RetryReadSafe, SafeMessage: "cannot resolve Herdr socket",
		}
	}
	selection := RuntimeSelection{Kind: RuntimeKindHerdr, Source: "herdr:" + socket}
	if binary, err := ResolveHerdrBinary(); err == nil {
		selection.Command = binary
	}
	return selection, nil
}

// OpenConfigured selects the runtime adapter for the daemon. An unset
// PAIRFOB_RUNTIME keeps the historical Herdr default when detection finds
// nothing, so the daemon's herdr_offline path still starts and recovers when
// Herdr appears later. An explicit value fails closed instead.
func OpenConfigured(devFake, multi bool) (rt Runtime, source string, err error) {
	if devFake {
		return NewFake(), "fake:explicit-dev", nil
	}
	selection, err := SelectRuntime(false)
	if err != nil {
		if strings.TrimSpace(os.Getenv("PAIRFOB_RUNTIME")) == "" {
			return Open(false, multi)
		}
		return nil, runtimeErrorSource(err), err
	}
	switch selection.Kind {
	case RuntimeKindHerdr:
		return Open(false, multi)
	case RuntimeKindCore:
		return NewCore(selection.Command), selection.Source, nil
	default:
		return nil, selection.Source, &Fault{
			Code: CodeInvalid, Operation: "runtime", Outcome: OutcomeNotApplied,
			Retry: RetryNever, SafeMessage: "unsupported terminal runtime " + selection.Kind,
		}
	}
}

func runtimeErrorSource(err error) string {
	if fault, ok := AsFault(err); ok && fault.Code == CodeInvalid {
		return "runtime:invalid"
	}
	return "runtime:offline"
}
