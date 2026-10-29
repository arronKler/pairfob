package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"pairfob/internal/admin"
	runtimeapi "pairfob/internal/runtime"
)

func (a liveAdmin) PrivacyStatus() admin.Privacy {
	names, err := runtimeapi.QuotaSelection()
	report := admin.Privacy{Executable: a.process.Executable, Providers: names, NativeKeychain: runtimeapi.NativeQuotaKeychainAvailable()}
	if err != nil {
		report.ConfigError = err.Error()
	}
	for _, row := range runtimeapi.QuotaKeychainDiagnostics() {
		report.Keychain = append(report.Keychain, admin.KeychainAccess{Provider: row.Provider, State: row.State, UpdatedAt: row.UpdatedAt, Paused: row.Paused})
	}
	return report
}

func (a liveAdmin) RetryKeychain(provider string) error {
	return runtimeapi.RetryQuotaKeychain(provider)
}

func quotaAuthorize(provider string, out io.Writer) error {
	if provider != "claude" && provider != "cursor" && provider != "antigravity" {
		return fmt.Errorf("choose claude, cursor or antigravity")
	}
	// Grant to the executable the daemon actually uses, not another checkout.
	sock, err := admin.SocketPath()
	if err != nil {
		return err
	}
	p, inspectErr := inspectLocalProcess(sock)
	if inspectErr != nil && !errors.Is(inspectErr, admin.ErrNotRunning) {
		return fmt.Errorf("cannot verify the running daemon before authorization: %w", inspectErr)
	}
	if inspectErr == nil {
		p.peer.Close()
		if p.legacy {
			return errors.New("the running daemon is too old to verify; update or stop it before authorizing this executable")
		}
		exe, exeErr := os.Executable()
		if exeErr != nil {
			return exeErr
		}
		exe, exeErr = filepath.EvalSymlinks(exe)
		if !p.legacy && (exeErr != nil || exe != p.info.Executable) {
			return fmt.Errorf("authorize using the daemon executable %q", p.info.Executable)
		}
		if !p.legacy {
			hash, hashErr := executableHash(exe)
			if hashErr != nil || hash != p.info.SHA256 {
				return fmt.Errorf("restart Pairfob before authorizing the newly installed executable")
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := runtimeapi.AuthorizeQuotaKeychain(ctx, provider); err != nil {
		return err
	}
	fmt.Fprintln(out, "Keychain read succeeded. Continued background access depends on the grant chosen in macOS.")
	return quotaRetry(provider, out)
}

func quotaRetry(provider string, out io.Writer) error {
	if err := runtimeapi.RetryQuotaKeychain(provider); err != nil {
		return err
	}
	sock, err := admin.SocketPath()
	if err != nil {
		return err
	}
	if _, err = admin.Call(sock, admin.Request{Op: "privacy.retry", Provider: provider}); err != nil {
		return fmt.Errorf("could not resume the running daemon; start or restart Pairfob, then refresh quota: %w", err)
	}
	fmt.Fprintln(out, "Silent reads resumed. Refresh quota after its one-minute cache expires.")
	return nil
}

// Never read credentials or probe protected folders to diagnose privacy. Live
// state is a snapshot of past reads; codesign inspects only the executable.
func writePrivacyDoctor(out io.Writer, sock string) {
	if runtime.GOOS != "darwin" {
		return
	}
	response, err := admin.Call(sock, admin.Request{Op: "privacy.status"})
	if err != nil {
		fmt.Fprintln(out, "\n  Privacy     live diagnostics unavailable; the daemon may need an update")
		return
	}
	var report admin.Privacy
	if json.Unmarshal(response.Result, &report) != nil {
		fmt.Fprintln(out, "\n  Privacy     invalid diagnostic response")
		return
	}
	writePrivacyReport(out, report)
	identity, err := readMacIdentity(report.Executable, runCodesign)
	if err != nil {
		fmt.Fprintln(out, "  Signing     could not inspect the installed image")
		return
	}
	if identity.team == "" {
		fmt.Fprintln(out, "  Signing     unsigned or ad-hoc; updates can require new privacy grants")
	} else {
		fmt.Fprintf(out, "  Signing     %q (team %s)\n", identity.identifier, identity.team)
	}
	fmt.Fprintln(out, "  Privacy     Full Disk Access is not probed; inspect it in macOS Privacy & Security")
}

func writePrivacyReport(out io.Writer, report admin.Privacy) {
	fmt.Fprintf(out, "\n  Executable  %q (on disk)\n", report.Executable)
	providers := strings.Join(report.Providers, ", ")
	if providers == "" {
		providers = "none"
	}
	fmt.Fprintf(out, "  Quota       %s\n", providers)
	if report.ConfigError != "" {
		fmt.Fprintf(out, "  Quota       %s\n", report.ConfigError)
	}
	mode := "silent native reads"
	if !report.NativeKeychain {
		mode = "unavailable in this build; background reads never fall back to prompting"
	}
	fmt.Fprintf(out, "  Keychain    %s\n", mode)
	for _, row := range report.Keychain {
		paused := ""
		if row.Paused {
			paused = "; paused — run pairfob quota authorize " + row.Provider
		}
		fmt.Fprintf(out, "    %s: %s (last read %s)%s\n", row.Provider, row.State, time.Unix(row.UpdatedAt, 0).Format(time.RFC3339), paused)
	}
}
