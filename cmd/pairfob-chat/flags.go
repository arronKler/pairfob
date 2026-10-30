package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// options is the parsed command line.
type options struct {
	agent        string
	agentCommand string
	cwd          string
	socketDir    string
	noTUI        bool
}

const usage = `usage: pairfob-chat [flags] [agent]

Runs one ACP agent over stdio, owns its transcript, and serves it on
pairfob-chat.v1 over a Unix socket.

agents:
  claude   claude-agent-acp (default)
  codex    codex-acp

flags:
  --agent-command PATH  adapter executable, overriding the agent default
  --cwd DIR             working directory for the agent and its session
  --socket-dir DIR      directory for the socket (default: XDG state)
  --no-tui              serve the socket without the terminal UI
`

// parseFlags accepts flags before or after the optional agent name.
func parseFlags(args []string) (options, error) {
	var parsed options
	flags := flag.NewFlagSet("pairfob-chat", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&parsed.agentCommand, "agent-command", "", "adapter executable")
	flags.StringVar(&parsed.cwd, "cwd", "", "working directory")
	flags.StringVar(&parsed.socketDir, "socket-dir", "", "socket directory")
	flags.BoolVar(&parsed.noTUI, "no-tui", false, "serve without the terminal UI")

	flagArgs, positional, err := splitArgs(args)
	if err != nil {
		return options{}, err
	}
	if err := flags.Parse(flagArgs); err != nil {
		return options{}, err
	}
	switch len(positional) {
	case 0:
		parsed.agent = "claude"
	case 1:
		parsed.agent = positional[0]
	default:
		return options{}, fmt.Errorf("expected at most one agent name, got %d", len(positional))
	}
	return parsed, nil
}

var valueFlags = map[string]bool{
	"--agent-command": true,
	"-agent-command":  true,
	"--cwd":           true,
	"-cwd":            true,
	"--socket-dir":    true,
	"-socket-dir":     true,
}

func splitArgs(args []string) ([]string, []string, error) {
	var flagArgs, positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positional = append(positional, arg)
			continue
		}
		flagArgs = append(flagArgs, arg)
		name := arg
		hasValue := false
		if index := strings.IndexByte(name, '='); index >= 0 {
			name = name[:index]
			hasValue = true
		}
		if hasValue || !valueFlags[name] {
			continue
		}
		i++
		if i >= len(args) {
			return nil, nil, fmt.Errorf("flag %s needs a value", arg)
		}
		flagArgs = append(flagArgs, args[i])
	}
	return flagArgs, positional, nil
}

// adapterCommand resolves the agent to an adapter executable. The two known
// agents have published ACP adapters; anything else needs --agent-command.
func adapterCommand(parsed options) ([]string, error) {
	if parsed.agentCommand != "" {
		return []string{parsed.agentCommand}, nil
	}
	var name string
	switch parsed.agent {
	case "claude":
		name = "claude-agent-acp"
	case "codex":
		name = "codex-acp"
	default:
		return nil, fmt.Errorf("unknown agent %q; pass --agent-command", parsed.agent)
	}
	path, err := findExecutable(name)
	if err != nil {
		return nil, err
	}
	return []string{path}, nil
}

// findExecutable checks PATH, then the places the installers put node tools.
func findExecutable(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, dir := range []string{
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".local", "bin", "node", "bin"),
		} {
			candidate := filepath.Join(dir, name)
			info, err := os.Stat(candidate)
			if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
				return candidate, nil
			}
		}
	}
	return "", fmt.Errorf("cannot find %s on PATH or under ~/.local/bin; pass --agent-command", name)
}

// newID returns the 16 lowercase hex process id.
func newID() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate chat id: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func isHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }
