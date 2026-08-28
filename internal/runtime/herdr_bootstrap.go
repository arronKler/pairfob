package runtime

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"
	"time"
)

const (
	herdrBootstrapProbeTimeout = 750 * time.Millisecond
	herdrStartupCWDEnv         = "HERDR_STARTUP_CWD"
)

type herdrServerLauncher func(context.Context, string, string, string) (<-chan error, error)

// HerdrServerAvailability reports whether EnsureServer had to start the
// default persistent Herdr server. A successful result always includes a
// descriptor read from the live socket; process creation alone is not success.
type HerdrServerAvailability struct {
	Descriptor Descriptor
	Started    bool
}

// EnsureServer leaves a usable server alone or starts the default persistent
// server and waits for its API socket. It never removes socket files and does
// not stop the server when Pairfob exits, so a later Herdr client can attach to
// the same panes.
func (h *Herdr) EnsureServer(ctx context.Context) (HerdrServerAvailability, error) {
	if h == nil || h.Socket == "" {
		return HerdrServerAvailability{}, errors.New("Herdr socket path is empty")
	}
	if descriptor, err := h.bootstrapDescribe(ctx); err == nil {
		return HerdrServerAvailability{Descriptor: descriptor}, nil
	} else if shouldStart, socketErr := herdrSocketNeedsServer(h.Socket); socketErr != nil {
		return HerdrServerAvailability{}, fmt.Errorf("inspect Herdr socket: %w", socketErr)
	} else if !shouldStart {
		return HerdrServerAvailability{}, fmt.Errorf("Herdr socket is listening but its API is not usable: %w", err)
	}

	binary, err := resolveHerdrBinary(h.TerminalBinary)
	if err != nil {
		return HerdrServerAvailability{}, fmt.Errorf("resolve Herdr CLI: %w", err)
	}
	launcher := h.launchServer
	if launcher == nil {
		launcher = launchPersistentHerdrServer
	}
	exited, err := launcher(ctx, binary, herdrStartupDirectory(), h.Socket)
	if err != nil {
		return HerdrServerAvailability{}, fmt.Errorf("start Herdr server: %w", err)
	}
	return h.waitForBootstrappedServer(ctx, exited)
}

func (h *Herdr) bootstrapDescribe(parent context.Context) (Descriptor, error) {
	ctx, cancel := context.WithTimeout(parent, herdrBootstrapProbeTimeout)
	defer cancel()
	return h.Describe(ctx, DefaultSession())
}

func (h *Herdr) waitForBootstrappedServer(ctx context.Context, exited <-chan error) (HerdrServerAvailability, error) {
	poll := h.bootstrapPoll
	if poll <= 0 {
		poll = 100 * time.Millisecond
	}
	var lastProbeErr error
	var processErr error
	for {
		descriptor, err := h.bootstrapDescribe(ctx)
		if err == nil {
			return HerdrServerAvailability{Descriptor: descriptor, Started: true}, nil
		}
		lastProbeErr = err

		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			stopTimer(timer)
			return HerdrServerAvailability{}, fmt.Errorf("Herdr server did not become ready: %w", errors.Join(ctx.Err(), lastProbeErr, processErr))
		case err, ok := <-exited:
			stopTimer(timer)
			if ok && err != nil {
				processErr = err
			}
			exited = nil
		case <-timer.C:
		}
	}
}

func stopTimer(timer *time.Timer) {
	if timer.Stop() {
		return
	}
	select {
	case <-timer.C:
	default:
	}
}

func herdrSocketNeedsServer(socket string) (bool, error) {
	connection, err := net.DialTimeout("unix", socket, 250*time.Millisecond)
	if err == nil {
		_ = connection.Close()
		return false, nil
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
		return true, nil
	}
	return false, err
}

func herdrStartupDirectory() string {
	if cwd, err := os.Getwd(); err == nil && filepath.IsAbs(cwd) {
		return cwd
	}
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		return home
	}
	return ""
}

func launchPersistentHerdrServer(ctx context.Context, binary, startupDir, socket string) (<-chan error, error) {
	var managedErr error
	if goruntime.GOOS == "linux" {
		if exited, err := launchSystemdHerdrServer(ctx, binary, startupDir, socket); err == nil {
			return exited, nil
		} else {
			managedErr = err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(managedErr, err)
	}
	exited, err := launchDetachedHerdrServer(binary, startupDir)
	if err != nil {
		return nil, errors.Join(managedErr, err)
	}
	return exited, nil
}

func launchSystemdHerdrServer(ctx context.Context, binary, startupDir, socket string) (<-chan error, error) {
	systemdRun, err := exec.LookPath("systemd-run")
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, systemdRun, systemdHerdrArgs(binary, startupDir, socket)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("systemd-run: %w: %s", err, string(output))
	}
	done := make(chan error)
	close(done)
	return done, nil
}

func systemdHerdrArgs(binary, startupDir, socket string) []string {
	digest := sha256.Sum256([]byte(socket))
	args := []string{
		"--user", "--quiet", "--collect",
		fmt.Sprintf("--unit=pairfob-herdr-%x", digest[:6]),
		"--property=Type=exec", "--property=Restart=no",
	}
	if startupDir != "" {
		args = append(args, "--working-directory="+startupDir, "--setenv="+herdrStartupCWDEnv+"="+startupDir)
	}
	for _, key := range []string{
		"HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_CONFIG_PATH",
		"HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_LOG",
		"HERDR_DISABLE_SOUND", "HERDR_PROCESS_DETECTION",
	} {
		if value := os.Getenv(key); value != "" {
			args = append(args, "--setenv="+key+"="+value)
		}
	}
	return append(args, "--", binary, "server")
}

func launchDetachedHerdrServer(binary, startupDir string) (<-chan error, error) {
	cmd := exec.Command(binary, "server")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = herdrServerEnvironment(startupDir)
	if startupDir != "" {
		cmd.Dir = startupDir
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
		close(done)
	}()
	return done, nil
}

func herdrServerEnvironment(startupDir string) []string {
	environment := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "PAIRFOB_") || key == herdrStartupCWDEnv ||
			key == "HERDR_ENV" || key == "HERDR_PANE_ID" || key == "HERDR_TAB_ID" || key == "HERDR_WORKSPACE_ID" {
			continue
		}
		environment = append(environment, entry)
	}
	if startupDir != "" {
		environment = append(environment, herdrStartupCWDEnv+"="+startupDir)
	}
	return environment
}
