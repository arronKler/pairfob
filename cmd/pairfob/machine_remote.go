package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// machineRemote runs fixed scripts on a saved machine through the operator's
// own OpenSSH. Scripts travel on stdin to `sh -s`, so nothing from a paired
// device or from the remote is ever interpolated into a command line.
type machineRemote struct {
	ssh string
}

var errMachineUnreachable = errors.New("machine unreachable over SSH")

const machineOfferHangup = 5 * time.Second

// Non-interactive on purpose: a background link must fail rather than wait on
// a password or host-key prompt nobody can see.
var machineSSHOptions = []string{
	"-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0",
	"-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
	"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-T",
}

const machineFindPairfob = `bin=""
for candidate in "$(command -v pairfob 2>/dev/null || true)" "$HOME/.local/bin/pairfob" /usr/local/bin/pairfob; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then bin="$candidate"; break; fi
done
`

const machineProbeScript = machineFindPairfob + `echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "bin=$bin"
if [ -n "$bin" ]; then
  if "$bin" pair offer --check >/dev/null 2>&1; then echo "offer=1"; fi
  if "$bin" pair status >/dev/null 2>&1; then echo "running=1"; fi
fi
`

const machineOfferScript = machineFindPairfob + `[ -n "$bin" ] || { echo "pairfob is not installed" >&2; exit 1; }
exec "$bin" pair offer
`

type machineProbe struct {
	OS, Arch, Bin  string
	Offer, Running bool
}

func (p machineProbe) supported() bool {
	return p.OS == "Linux" || p.OS == "Darwin"
}

// needsInstall also covers an older Pairfob that cannot hand out an offer:
// install.sh is the supported upgrade path.
func (p machineProbe) needsInstall() bool {
	return p.Bin == "" || !p.Offer
}

func (r machineRemote) command(ctx context.Context, target string) *exec.Cmd {
	binary := r.ssh
	if binary == "" {
		binary = "ssh"
	}
	args := append(append([]string(nil), machineSSHOptions...), "--", target, "/bin/sh", "-s")
	return exec.CommandContext(ctx, binary, args...)
}

func (r machineRemote) run(ctx context.Context, target, script string, progress io.Writer) ([]byte, error) {
	cmd := r.command(ctx, target)
	cmd.Stdin = strings.NewReader(script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if progress != nil {
		cmd.Stdout = io.MultiWriter(&stdout, progress)
		cmd.Stderr = io.MultiWriter(&stderr, progress)
	}
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), machineRunError(err, stderr.String())
	}
	return stdout.Bytes(), nil
}

// ssh reserves exit status 255 for its own failures; anything else is the
// remote script's verdict.
func machineRunError(err error, stderr string) error {
	detail := errorTail(stderr)
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return fmt.Errorf("%w: %v", errMachineUnreachable, err)
	}
	if exit.ExitCode() == 255 {
		if detail == "" {
			return errMachineUnreachable
		}
		return fmt.Errorf("%w: %s", errMachineUnreachable, detail)
	}
	if detail == "" {
		detail = err.Error()
	}
	return errors.New(detail)
}

// errorTail keeps the end of a remote script's stderr: its last line is often
// a wrapper's exit status, and the reason sits just above it.
func errorTail(text string) string {
	var kept []string
	lines := strings.Split(strings.TrimSpace(text), "\n")
	for i := len(lines) - 1; i >= 0 && len(kept) < 3; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			kept = append([]string{line}, kept...)
		}
	}
	tail := strings.Join(kept, " | ")
	if len(tail) > 480 {
		tail = tail[len(tail)-480:]
	}
	return tail
}

func (r machineRemote) probe(ctx context.Context, target string) (machineProbe, error) {
	out, err := r.run(ctx, target, machineProbeScript, nil)
	if err != nil {
		return machineProbe{}, err
	}
	var probe machineProbe
	for _, line := range strings.Split(string(out), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "os":
			probe.OS = value
		case "arch":
			probe.Arch = value
		case "bin":
			probe.Bin = value
		case "offer":
			probe.Offer = value == "1"
		case "running":
			probe.Running = value == "1"
		}
	}
	if probe.OS == "" {
		return machineProbe{}, errors.New("the machine did not answer the Pairfob check")
	}
	return probe, nil
}

// machineInstall carries the only values that reach a remote script. Both are
// validated URLs from this computer's own environment and are single-quoted.
type machineInstall struct {
	DownloadBase string
	Origin       string
}

func (plan machineInstall) script() (string, error) {
	base := plan.DownloadBase
	if base == "" {
		base = defaultDownloadBase
	}
	if err := allowedDownloadBase(base); err != nil {
		return "", err
	}
	root, ok := strings.CutSuffix(base, "/dl")
	if !ok {
		return "", errors.New("PAIRFOB_DOWNLOAD_BASE must end in /dl to install on another machine")
	}
	var b strings.Builder
	b.WriteString("set -eu\ntmp=\"$(mktemp)\"\ntrap 'rm -f \"$tmp\"' 0\n")
	fmt.Fprintf(&b, "curl -fsSL %s -o \"$tmp\"\n", shellQuote(root+"/install.sh"))
	if base != defaultDownloadBase {
		fmt.Fprintf(&b, "export PAIRFOB_DOWNLOAD_BASE=%s\n", shellQuote(base))
	}
	b.WriteString("sh \"$tmp\" --non-interactive")
	if plan.Origin != "" {
		origin, err := canonicalHTTPOrigin(plan.Origin)
		if err != nil {
			return "", fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
		}
		fmt.Fprintf(&b, " --origin %s", shellQuote(origin))
	}
	b.WriteString("\n")
	return b.String(), nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func (r machineRemote) install(ctx context.Context, target string, plan machineInstall, progress io.Writer) error {
	script, err := plan.script()
	if err != nil {
		return err
	}
	_, err = r.run(ctx, target, script, progress)
	return err
}

// machineOffer is a live `pairfob pair offer` on the remote. Its stdin stays
// open for as long as this computer still wants the pairing; closing it is how
// the remote learns to deny the slot.
type machineOffer struct {
	Offer  pairOfferEvent
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  *bufio.Scanner
	stderr *bytes.Buffer
	once   sync.Once
}

func (r machineRemote) offer(ctx context.Context, target string) (*machineOffer, error) {
	cmd := r.command(ctx, target)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	// Cancelling hangs up first so the remote denies its slot; the kill is
	// only for an ssh that does not notice.
	cmd.Cancel = stdin.Close
	cmd.WaitDelay = machineOfferHangup
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%w: %v", errMachineUnreachable, err)
	}
	offer := &machineOffer{cmd: cmd, stdin: stdin, lines: bufio.NewScanner(stdout), stderr: stderr}
	if _, err := io.WriteString(stdin, machineOfferScript); err != nil {
		return nil, offer.fail(err)
	}
	event, err := offer.next()
	if err != nil {
		return nil, err
	}
	if event.Event != "offer" || event.Ref == "" || event.URL == "" || event.Code == "" || event.ExpiresAt == nil {
		return nil, offer.fail(errors.New("the machine returned an invalid pairing offer"))
	}
	offer.Offer = event
	return offer, nil
}

func (o *machineOffer) next() (pairOfferEvent, error) {
	if !o.lines.Scan() {
		return pairOfferEvent{}, o.fail(io.ErrUnexpectedEOF)
	}
	var event pairOfferEvent
	if err := json.Unmarshal(o.lines.Bytes(), &event); err != nil {
		return pairOfferEvent{}, o.fail(errors.New("the machine returned an unreadable pairing event"))
	}
	if event.Event == "error" {
		return pairOfferEvent{}, o.fail(errors.New(event.Message))
	}
	return event, nil
}

// Wait returns once the remote daemon has accepted the device that proved the
// offer's code.
func (o *machineOffer) Wait() error {
	for {
		event, err := o.next()
		if err != nil {
			return err
		}
		if event.Event == "paired" {
			o.Close()
			return nil
		}
	}
}

func (o *machineOffer) Close() {
	o.once.Do(func() {
		_ = o.stdin.Close()
		_ = o.cmd.Wait()
	})
}

func (o *machineOffer) fail(cause error) error {
	var waitErr error
	o.once.Do(func() {
		_ = o.stdin.Close()
		waitErr = o.cmd.Wait()
	})
	if errors.Is(cause, io.ErrUnexpectedEOF) && waitErr != nil {
		return machineRunError(waitErr, o.stderr.String())
	}
	if errors.Is(cause, io.ErrUnexpectedEOF) {
		return errors.New("the machine closed the pairing offer early")
	}
	return cause
}
