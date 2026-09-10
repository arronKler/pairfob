package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	runtimeapi "pairfob/internal/runtime"
)

// Persist only runtime configuration, never pairing credentials or the current
// Herdr pane identity. A login service must use the runtime setup just checked.
// Relative paths retain the caller's context; the installer calls from home.
func serviceRuntimeEnvironment() [][2]string {
	var out [][2]string
	for _, key := range []string{"HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH", "HERDR_CLIENT_SOCKET_PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PAIRFOB_STATE_DIR", "PAIRFOB_ADMIN_SOCK", "PAIRFOB_HERDR_AUTOSTART", "PAIRFOB_MULTI_SESSION"} {
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		if (!strings.HasPrefix(key, "PAIRFOB_") || key == "PAIRFOB_STATE_DIR" || key == "PAIRFOB_ADMIN_SOCK") && !filepath.IsAbs(value) {
			if absolute, err := filepath.Abs(value); err == nil {
				value = absolute
			}
		}
		out = append(out, [2]string{key, value})
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
	// Resolve against the installer's PATH before launchd/systemd replace it.
	if binary, err := runtimeapi.ResolveHerdrBinary(); err == nil {
		out = append(out, [2]string{"HERDR_BIN", binary})
	} else if value := os.Getenv("HERDR_BIN"); value != "" {
		out = append(out, [2]string{"HERDR_BIN", value})
	}
	return out
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
