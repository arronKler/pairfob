package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"pairfob/internal/runtime"
)

var quotaReasonText = map[string]string{
	"unavailable":       "could not be read this time",
	"timeout":           "timed out",
	"relogin":           "sign in again on this computer",
	"allow_keychain":    "keychain needs local attention; run pairfob doctor",
	"choose_account":    "more than one login; keep one",
	"setup":             "run pairfob quota-setup-claude",
	"no_login":          "no login found",
	"not_installed":     "command not found",
	"not_running":       "app not running",
	"unsupported_login": "this login has no subscription allowance",
}

// quotaCLI reads the same accounts the phone's quota page shows, once and with
// no cache. It prints states and shares only: no credential, path or raw reply.
func quotaCLI(args []string, out io.Writer) error {
	if len(args) == 2 && args[0] == "authorize" {
		return quotaAuthorize(args[1], out)
	}
	if len(args) == 2 && args[0] == "retry" {
		return quotaRetry(args[1], out)
	}
	if len(args) != 1 || args[0] != "list" {
		return errors.New("usage: pairfob quota list | authorize <claude|cursor|antigravity> | retry <claude|cursor|antigravity>")
	}
	if _, err := runtime.QuotaSelection(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	printQuotaAccounts(out, runtime.ReadQuotaAccounts(ctx))
	fmt.Fprintln(out, "\nRead with this shell's environment. The background service reads with the one it was installed from.")
	return nil
}

func printQuotaAccounts(out io.Writer, readings []runtime.QuotaReading) {
	table := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	for _, reading := range readings {
		a := reading.Account
		plan := a.Plan
		if plan == "" {
			plan = "-"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\n", a.ID, strings.ReplaceAll(a.State, "_", " "), plan, quotaAccountLine(a))
	}
	_ = table.Flush()
}

func quotaAccountLine(a runtime.QuotaAccount) string {
	var parts []string
	if reason := quotaReasonText[a.Reason]; reason != "" {
		parts = append(parts, reason)
	}
	if a.State == "throttled" {
		parts = append(parts, "the provider asked to be queried less often")
	}
	others := 0
	for _, m := range a.Meters {
		if !m.Headline {
			others++
			continue
		}
		parts = append(parts, quotaMeterText(m))
	}
	if others > 0 {
		parts = append(parts, fmt.Sprintf("%d more", others))
	}
	return strings.Join(parts, " · ")
}

func quotaMeterText(m runtime.QuotaMeter) string {
	label := m.Name
	switch {
	case m.WindowMinutes > 0 && m.WindowMinutes%1440 == 0:
		label = fmt.Sprintf("%dd", m.WindowMinutes/1440)
	case m.WindowMinutes > 0 && m.WindowMinutes%60 == 0:
		label = fmt.Sprintf("%dh", m.WindowMinutes/60)
	}
	switch m.Kind {
	case "quota":
		return fmt.Sprintf("%s %.0f%% left", label, 100-*m.UsedPercent)
	case "unlimited":
		return label + " unlimited"
	case "level":
		return label + " " + m.Level
	case "balance":
		return fmt.Sprintf("%s %s %s", label, quotaAmountText(*m.Amount, m.Scale), m.Unit)
	}
	return label + " not read"
}

// quotaAmountText writes an integer amount with its decimal places.
func quotaAmountText(amount int64, scale int) string {
	if scale == 0 {
		return fmt.Sprint(amount)
	}
	digits := fmt.Sprintf("%0*d", scale+1, amount)
	return digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
}
