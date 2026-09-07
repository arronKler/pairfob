package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"pairfob/internal/runtime"
)

func quotaStatusline(args []string, input io.Reader, output io.Writer) error {
	if len(args) > 1 {
		return errors.New("usage: pairfob quota-statusline [previous-statusline-command]")
	}
	raw, err := io.ReadAll(io.LimitReader(input, 1024*1024+1))
	if err != nil {
		return err
	}
	var q runtime.AgentQuota
	var parseErr error
	if len(raw) <= 1024*1024 {
		q, parseErr = runtime.ParseClaudeQuota(raw, time.Now())
	} else {
		parseErr = errors.New("statusline input too large")
	}
	if parseErr == nil {
		path, pathErr := runtime.ClaudeQuotaPath()
		if pathErr == nil {
			data, _ := json.Marshal(q)
			_ = writeQuotaFile(path, data)
		}
	}
	// Existing local statusline configuration remains responsible for its output.
	// Cache failures must not break it; the phone ages out the last sample.
	if len(args) == 1 && args[0] != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "sh", "-c", args[0])
		cmd.Stdin = io.MultiReader(bytes.NewReader(raw), input)
		cmd.Stdout = output
		cmd.Stderr = os.Stderr
		cmd.WaitDelay = time.Second
		return cmd.Run()
	}
	if parseErr != nil {
		return parseErr
	}
	for i, w := range q.Windows {
		if i > 0 {
			_, _ = fmt.Fprint(output, " · ")
		}
		_, _ = fmt.Fprintf(output, "%s %.0f%% left", w.Name, 100-w.UsedPercent)
	}
	if len(q.Windows) == 0 {
		_, _ = fmt.Fprint(output, "Claude Code")
	}
	_, err = fmt.Fprintln(output)
	return err
}

func writeQuotaFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".pairfob-quota-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func shellQuotaQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func setupClaudeQuota(args []string) error {
	if len(args) != 0 {
		return errors.New("usage: pairfob quota-setup-claude")
	}
	path, err := runtime.ClaudeQuotaPath()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	settings := filepath.Join(filepath.Dir(path), "settings.json")
	if err = installClaudeQuota(settings, exe); err != nil {
		return err
	}
	fmt.Println("Claude quota collection enabled. Start a new Claude Code session. Original settings: " + settings + ".pairfob-backup")
	return nil
}

func installClaudeQuota(path, exe string) error {
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(raw) > 1024*1024 {
		return errors.New("Claude settings too large")
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	var settings map[string]json.RawMessage
	if err = json.Unmarshal(raw, &settings); err != nil || settings == nil {
		return errors.New("invalid Claude settings")
	}
	var previous struct {
		Type    string `json:"type"`
		Command string `json:"command"`
	}
	line := map[string]json.RawMessage{}
	if value, ok := settings["statusLine"]; ok {
		if json.Unmarshal(value, &previous) != nil || previous.Type != "command" || json.Unmarshal(value, &line) != nil {
			return errors.New("unsupported existing statusLine; configure quota-statusline manually")
		}
		if previous.Command == shellQuotaQuote(exe)+" quota-statusline" || strings.HasPrefix(previous.Command, shellQuotaQuote(exe)+" quota-statusline ") {
			return nil
		}
	}
	command := shellQuotaQuote(exe) + " quota-statusline"
	if previous.Command != "" {
		command += " " + shellQuotaQuote(previous.Command)
	}
	line["type"] = json.RawMessage(`"command"`)
	line["command"], _ = json.Marshal(command)
	settings["statusLine"], _ = json.Marshal(line)
	updated, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	backup, err := os.OpenFile(path+".pairfob-backup", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("preserve original settings before setup: %w", err)
	}
	_, err = backup.Write(raw)
	closeErr := backup.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return writeQuotaFile(path, append(updated, '\n'))
}
