package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
)

// Follow Cursor CLI's credential store selection, not its editor or browser.
// A different store may belong to another account, so failures never fall back.
func cursorQuotaToken(ctx context.Context) (string, string) {
	endpoint := strings.TrimRight(os.Getenv("CURSOR_API_ENDPOINT"), "/")
	if endpoint != "" && endpoint != "https://api2.cursor.sh" {
		return "", "unsupported"
	}
	if token := os.Getenv("CURSOR_AUTH_TOKEN"); token != "" {
		return token, ""
	}
	// Do not display a saved account's allowance when the CLI selects an API key.
	// API-key exchange and refresh-token rotation are not read-only quota queries.
	if os.Getenv("CURSOR_API_KEY") != "" {
		return "", "unsupported"
	}
	if os.Getenv("PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN") == "1" {
		return "", "unsupported"
	}
	switch cursorQuotaStore(goruntime.GOOS, os.Getenv("AGENT_CLI_CREDENTIAL_STORE")) {
	case "memory":
		return "", "auth_required"
	case "keychain":
		return cursorQuotaKeychain(ctx)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "auth_required"
	}
	path := cursorQuotaAuthPath(goruntime.GOOS, home, os.Getenv("XDG_CONFIG_HOME"), os.Getenv("APPDATA"))
	raw, err := quotaFile(path, 1024*1024)
	if os.IsNotExist(err) {
		return "", "not_logged_in"
	}
	if err != nil {
		return "", "auth_required"
	}
	var auth struct {
		AccessToken string `json:"accessToken"`
		APIKey      string `json:"apiKey"`
	}
	if json.Unmarshal(raw, &auth) != nil {
		return "", "auth_required"
	}
	if auth.AccessToken == "" {
		if auth.APIKey != "" {
			return "", "unsupported"
		}
		return "", "auth_required"
	}
	return auth.AccessToken, ""
}

func cursorQuotaStore(platform, mode string) string {
	if mode == "file" || mode == "memory" {
		return mode
	}
	if platform == "darwin" {
		return "keychain"
	}
	return "file"
}

// CURSOR_CONFIG_DIR changes CLI settings, but not its credential file path.
func cursorQuotaAuthPath(platform, home, xdg, appdata string) string {
	switch platform {
	case "darwin":
		return filepath.Join(home, ".cursor", "auth.json")
	case "windows":
		if appdata == "" {
			appdata = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appdata, "Cursor", "auth.json")
	default:
		if xdg == "" {
			xdg = filepath.Join(home, ".config")
		}
		return filepath.Join(xdg, "cursor", "auth.json")
	}
}
