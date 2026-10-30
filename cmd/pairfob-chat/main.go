// Command pairfob-chat runs one ACP agent, owns its transcript, serves
// pairfob-chat.v1 over a Unix socket, and registers pairfob-chat=<id> on its
// Herdr pane.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/endpoint"
	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/token"
	"pairfob/internal/chat/tui"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "pairfob-chat:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	parsed, err := parseFlags(args)
	if err != nil {
		if isHelp(err) {
			fmt.Fprint(stdout, usage)
			return nil
		}
		fmt.Fprint(stderr, usage)
		return err
	}

	cwd, err := resolveCwd(parsed.cwd)
	if err != nil {
		return err
	}
	id, err := newID()
	if err != nil {
		return err
	}
	socketDir := parsed.socketDir
	if socketDir == "" {
		socketDir, err = endpoint.DefaultDir()
		if err != nil {
			return err
		}
	}
	socketPath := endpoint.SocketPath(socketDir, id)

	title := fmt.Sprintf("%s · %s", parsed.agent, filepath.Base(cwd))
	transcript := hub.New(hub.Config{ID: id, Agent: parsed.agent, Title: title})

	server, err := endpoint.Listen(endpoint.Options{Path: socketPath, Hub: transcript})
	if err != nil {
		return err
	}
	defer server.Close()
	go func() {
		if err := server.Serve(); err != nil {
			fmt.Fprintf(stderr, "pairfob-chat: serve: %v\n", err)
		}
	}()

	fmt.Fprintf(stdout, "pairfob-chat %s %s\n", id, socketPath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	heartbeat := token.Start(ctx, token.Options{
		PaneID: os.Getenv("HERDR_PANE_ID"),
		Token:  token.NewToken(id),
		Logf: func(format string, args ...any) {
			fmt.Fprintf(stderr, "pairfob-chat: "+format+"\n", args...)
		},
	})
	defer heartbeat.Stop()

	client, err := startAgent(ctx, parsed, cwd, transcript)
	if client != nil {
		defer client.Close()
	}
	if err != nil {
		// The transcript keeps serving so a view can read the failure.
		fmt.Fprintf(stderr, "pairfob-chat: %v\n", err)
	}

	if parsed.noTUI {
		<-ctx.Done()
		return nil
	}
	return runTUI(ctx, transcript)
}

// startAgent resolves, launches and initializes the adapter. A failure marks
// the transcript exited instead of ending the process; a returned client is
// live and owned by the caller.
func startAgent(ctx context.Context, parsed options, cwd string, transcript *hub.Hub) (*acp.Client, error) {
	command, err := adapterCommand(parsed)
	if err != nil {
		transcript.Fail(err)
		return nil, err
	}
	client, err := acp.Start(acp.Options{Command: command, Dir: cwd})
	if err != nil {
		transcript.Fail(err)
		return nil, err
	}
	transcript.SetAgent(client)
	go transcript.Run()

	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if _, err := client.Initialize(callCtx); err != nil {
		transcript.Fail(fmt.Errorf("initialize %s: %w", command[0], err))
		return client, fmt.Errorf("initialize %s: %w", command[0], err)
	}
	session, err := client.NewSession(callCtx, cwd, nil)
	if err == nil && session.SessionID == "" {
		err = errors.New("adapter returned an empty session id")
	}
	if err != nil {
		transcript.Fail(fmt.Errorf("open session: %w", err))
		return client, fmt.Errorf("open session: %w", err)
	}
	if err := transcript.Ready(session); err != nil {
		return client, fmt.Errorf("apply session: %w", err)
	}
	return client, nil
}

func runTUI(ctx context.Context, transcript *hub.Hub) error {
	program := tea.NewProgram(
		tui.New(transcript),
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)
	quit := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			program.Quit()
		case <-quit:
		}
	}()
	_, err := program.Run()
	close(quit)
	if err != nil {
		return fmt.Errorf("terminal UI: %w", err)
	}
	return nil
}

func resolveCwd(flagValue string) (string, error) {
	cwd := flagValue
	if cwd == "" {
		current, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("working directory: %w", err)
		}
		cwd = current
	}
	absolute, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("working directory %q: %w", cwd, err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("working directory %q: %w", cwd, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("working directory %q is not a directory", cwd)
	}
	return absolute, nil
}
