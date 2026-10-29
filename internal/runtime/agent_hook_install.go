package runtime

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
)

//go:embed agent-hooks/amp.js agent-hooks/maki.lua agent-hooks/command-code.js
var agentHookFiles embed.FS
var agentHookInstallMu sync.Mutex

const hookMarker = "Pairfob session observation: managed file."

// InstallAgentObservation prepares only this agent's local integrations. Files
// belonging to the user are preserved; an incompatible configuration is an
// explicit error instead of silently replacing their hooks or permissions.
func InstallAgentObservation(agent, binary string) error {
	if !localBindingAgent(agent) {
		return errors.New("unsupported observation agent")
	}
	if goruntime.GOOS != "darwin" && goruntime.GOOS != "linux" {
		return errors.New("local agent observation requires macOS or Linux")
	}
	if !filepath.IsAbs(binary) || strings.ContainsAny(binary, "\x00\n\r") {
		return errors.New("invalid Pairfob executable path")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return errors.New("home directory unavailable")
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		config = filepath.Join(home, ".config")
	}
	agentHookInstallMu.Lock()
	defer agentHookInstallMu.Unlock()
	switch agent {
	case "cmd":
		data, _ := agentHookFiles.ReadFile("agent-hooks/command-code.js")
		return writeManagedHook(filepath.Join(home, ".commandcode", "mods", "pairfob-session.ts"), strings.ReplaceAll(string(data), "PAIRFOB_BINARY", strconv.Quote(binary)), 0600)
	case "gemini":
		return installGeminiHook(filepath.Join(home, ".gemini", "settings.json"), binary)
	case "cline":
		root := os.Getenv("CLINE_DIR")
		if root == "" {
			root = filepath.Join(home, ".cline")
		}
		return installClineHooks(filepath.Join(root, "hooks"), binary)
	case "amp":
		data, _ := agentHookFiles.ReadFile("agent-hooks/amp.js")
		return writeManagedHook(filepath.Join(config, "amp", "plugins", "pairfob-session.js"), strings.ReplaceAll(string(data), "PAIRFOB_BINARY", strconv.Quote(binary)), 0600)
	case "maki":
		root := filepath.Join(config, "maki")
		legacy := filepath.Join(home, ".maki")
		if info, err := os.Stat(legacy); err == nil && info.IsDir() {
			_, legacyInit := os.Lstat(filepath.Join(legacy, "init.lua"))
			_, xdgInit := os.Lstat(filepath.Join(root, "init.lua"))
			// A legacy sessions directory alone must not shadow the user's
			// existing XDG init.lua by creating a new higher-priority config.
			if legacyInit == nil || errors.Is(xdgInit, os.ErrNotExist) {
				root = legacy
			}
		}
		return installMakiHook(root, binary)
	}
	return nil
}

func hookFile(path string) ([]byte, os.FileMode, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0600, nil
	}
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, 0, fmt.Errorf("unsupported hook/config file: %s", path)
	}
	data, err := os.ReadFile(path)
	return data, info.Mode().Perm(), err
}

func replaceHookFile(path string, before, after []byte, mode os.FileMode) error {
	if bytes.Equal(before, after) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	now, _, err := hookFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(now, before) {
		return errors.New("hook configuration changed while installing")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".pairfob-hook-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	_, err = file.Write(after)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func writeManagedHook(path, content string, mode os.FileMode) error {
	before, _, err := hookFile(path)
	if err != nil {
		return err
	}
	if len(before) != 0 && !strings.Contains(string(before), hookMarker) {
		return fmt.Errorf("refusing to replace user hook: %s", path)
	}
	return replaceHookFile(path, before, []byte(content), mode)
}

func shellQuoteHook(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func installGeminiHook(path, binary string) error {
	before, mode, err := hookFile(path)
	if err != nil {
		return err
	}
	settings := map[string]any{}
	if len(before) != 0 {
		decoder := json.NewDecoder(bytes.NewReader(before))
		decoder.UseNumber()
		if err := decoder.Decode(&settings); err != nil || settings == nil {
			return errors.New("Gemini settings must be a JSON object")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return errors.New("Gemini settings contain trailing data")
		}
	}
	if config, ok := settings["hooksConfig"].(map[string]any); ok && config["enabled"] == false {
		return errors.New("Gemini hooks are disabled in settings")
	}
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		if settings["hooks"] != nil {
			return errors.New("unsupported Gemini hooks configuration")
		}
		hooks = map[string]any{}
		settings["hooks"] = hooks
	}
	for _, event := range []string{"SessionStart", "BeforeAgent", "SessionEnd"} {
		entries, ok := hooks[event].([]any)
		if hooks[event] != nil && !ok {
			return errors.New("unsupported Gemini hook event configuration")
		}
		kept := make([]any, 0, len(entries)+1)
		for _, entry := range entries {
			group, ok := entry.(map[string]any)
			if !ok {
				return errors.New("invalid Gemini hook group")
			}
			// Only our complete dedicated group is replaced. Other commands,
			// including commands in mixed groups, are left untouched.
			commands, _ := group["hooks"].([]any)
			if len(commands) == 1 {
				command, _ := commands[0].(map[string]any)
				if command["name"] == "pairfob-session-observation" {
					continue
				}
			}
			kept = append(kept, entry)
		}
		hooks[event] = append(kept, map[string]any{"matcher": "*", "hooks": []any{map[string]any{"name": "pairfob-session-observation", "type": "command", "command": shellQuoteHook(binary) + " agent-hook gemini", "timeout": 4000}}})
	}
	after, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return replaceHookFile(path, before, append(after, '\n'), mode)
}

func installClineHooks(root, binary string) error {
	content := "#!/bin/sh\n# " + hookMarker + "\nexec " + shellQuoteHook(binary) + " agent-hook cline\n"
	for _, event := range []string{"TaskStart", "TaskResume", "UserPromptSubmit", "SessionShutdown"} {
		installed := false
		for _, ext := range []string{".sh", ".bash", ".zsh"} {
			path := filepath.Join(root, event+ext)
			before, _, err := hookFile(path)
			if err != nil {
				return err
			}
			if len(before) != 0 && !strings.Contains(string(before), hookMarker) {
				continue
			}
			if err := writeManagedHook(path, content, 0700); err != nil {
				return err
			}
			installed = true
			break
		}
		if !installed {
			return fmt.Errorf("no free Cline hook file for %s", event)
		}
	}
	return nil
}

func installMakiHook(root, binary string) error {
	module := filepath.Join(root, "lua", "pairfob_session")
	data, _ := agentHookFiles.ReadFile("agent-hooks/maki.lua")
	if err := writeManagedHook(filepath.Join(module, "init.lua"), strings.ReplaceAll(string(data), "PAIRFOB_BINARY", strconv.Quote(binary)), 0600); err != nil {
		return err
	}
	permissions := "# " + hookMarker + "\n[permissions]\nrun = true\nenv = true\nfs_read = false\nfs_write = false\nnet = false\nagent = false\nsession_read = false\nsession_write = false\nsession_settings = false\ninput = false\n"
	if err := writeManagedHook(filepath.Join(module, "plugin.toml"), permissions, 0600); err != nil {
		return err
	}
	path := filepath.Join(root, "init.lua")
	before, mode, err := hookFile(path)
	if err != nil {
		return err
	}
	line := "require(\"pairfob_session\") -- pairfob-session-observation"
	if strings.Contains(string(before), line) {
		return nil
	}
	// Prepend so an init ending with `return` stays valid Lua and still loads us.
	after := append([]byte(line+"\n"), before...)
	if bytes.HasPrefix(before, []byte("#!")) {
		if end := bytes.IndexByte(before, '\n'); end >= 0 {
			after = append(append(append([]byte(nil), before[:end+1]...), []byte(line+"\n")...), before[end+1:]...)
		}
	}
	return replaceHookFile(path, before, after, mode)
}
