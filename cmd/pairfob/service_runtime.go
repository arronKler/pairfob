package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	runtimeapi "pairfob/internal/runtime"
)

var serviceCopiedKeys = []string{"HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH", "HERDR_CLIENT_SOCKET_PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "PAIRFOB_STATE_DIR", "PAIRFOB_ADMIN_SOCK", "PAIRFOB_HERDR_AUTOSTART", "PAIRFOB_MULTI_SESSION", "PAIRFOB_RUNTIME", "PAIRFOB_HC", "HC_SESSION", "HC_SOCKET", "PAIRFOB_PUSH", "PAIRFOB_VAPID_SUBJECT", "PAIRFOB_QUOTA_PROVIDERS"}

// The variables serviceRuntimeEnvironment writes. None holds a credential, so
// an install may print their values; any other variable is named only.
var servicePersistedKeys = append(append([]string(nil), serviceCopiedKeys...),
	"PAIRFOB_CLAUDE_QUOTA_SOURCE", "AGENT_CLI_CREDENTIAL_STORE", "PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN", "HERDR_BIN")

// Persist only runtime configuration, never pairing credentials or the current
// Herdr pane identity. A login service must use the runtime setup just checked.
// Relative paths retain the caller's context; the installer calls from home.
func serviceRuntimeEnvironment() [][2]string {
	selection, selectionErr := runtimeapi.SelectRuntime(false)
	core := selectionErr == nil && selection.Kind == runtimeapi.RuntimeKindCore
	var out [][2]string
	for _, key := range serviceCopiedKeys {
		if core && (key == "PAIRFOB_RUNTIME" || key == "PAIRFOB_HC") {
			continue
		}
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		if key == "PAIRFOB_HC" {
			// launchd and systemd do not inherit the installer's PATH. Resolve
			// the client once so the service can start the same binary.
			if resolved, err := exec.LookPath(value); err == nil {
				value = resolved
			}
			out = append(out, [2]string{key, value})
			continue
		}
		if key != "HC_SESSION" && (!strings.HasPrefix(key, "PAIRFOB_") || key == "PAIRFOB_STATE_DIR" || key == "PAIRFOB_ADMIN_SOCK") && !filepath.IsAbs(value) {
			if absolute, err := filepath.Abs(value); err == nil {
				value = absolute
			}
		}
		out = append(out, [2]string{key, value})
	}
	if os.Getenv("PAIRFOB_CLAUDE_QUOTA_SOURCE") == "statusline" {
		out = append(out, [2]string{"PAIRFOB_CLAUDE_QUOTA_SOURCE", "statusline"})
	}
	// Cursor CLI's file/memory selector is not a path or a credential. Preserve
	// it for background quota reads, but never persist Cursor tokens or API keys.
	if mode := os.Getenv("AGENT_CLI_CREDENTIAL_STORE"); mode == "file" || mode == "memory" || mode == "default" {
		out = append(out, [2]string{"AGENT_CLI_CREDENTIAL_STORE", mode})
	}
	// Omitting a transient credential must not select another saved account.
	// Only a local marker survives installation; no secret or custom URL does.
	endpoint := strings.TrimRight(os.Getenv("CURSOR_API_ENDPOINT"), "/")
	if os.Getenv("CURSOR_AUTH_TOKEN") != "" || os.Getenv("CURSOR_API_KEY") != "" ||
		(endpoint != "" && endpoint != "https://api2.cursor.sh") || os.Getenv("PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN") == "1" {
		out = append(out, [2]string{"PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN", "1"})
	}
	if core {
		// Auto-detection selected herdr-core. Persisting the concrete choice
		// keeps launchd and systemd on the same runtime after login.
		out = append(out, [2]string{"PAIRFOB_RUNTIME", "core"})
		out = append(out, [2]string{"PAIRFOB_HC", absoluteRuntimeCommand(selection.Command)})
		return out
	}
	// Resolve against the installer's PATH before launchd/systemd replace it.
	if binary, err := runtimeapi.ResolveHerdrBinary(); err == nil {
		out = append(out, [2]string{"HERDR_BIN", binary})
	} else if value := os.Getenv("HERDR_BIN"); value != "" {
		out = append(out, [2]string{"HERDR_BIN", value})
	}
	return out
}

func absoluteRuntimeCommand(command string) string {
	if strings.TrimSpace(command) == "" {
		command = runtimeapi.DefaultHC()
	}
	if resolved, err := exec.LookPath(command); err == nil {
		if absolute, absErr := filepath.Abs(resolved); absErr == nil {
			return absolute
		}
		return resolved
	}
	// A bare command that is not on this PATH is kept by name so the service's
	// own PATH can resolve it. Only an explicit path is made absolute.
	if strings.ContainsRune(command, os.PathSeparator) {
		if absolute, err := filepath.Abs(command); err == nil {
			return absolute
		}
	}
	return command
}

func launchdRuntimeEnvironment() string {
	var out strings.Builder
	for _, env := range serviceRuntimeEnvironment() {
		out.WriteString("    <key>" + xmlEscape(env[0]) + "</key>\n    <string>" + xmlEscape(env[1]) + "</string>\n")
	}
	return out.String()
}

func systemdRuntimeEnvironment() string {
	var out strings.Builder
	for _, env := range serviceRuntimeEnvironment() {
		out.WriteString("Environment=" + env[0] + "=" + systemdEnvironmentValue(env[1]) + "\n")
	}
	return out.String()
}

func systemdEnvironmentValue(value string) string {
	return strconv.Quote(strings.ReplaceAll(value, "%", "%%"))
}
