package runtime

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// Run a test subprocess instead of touching the operator's real Keychain.
func TestCursorQuotaSecurityProcess(t *testing.T) {
	if os.Getenv("PAIRFOB_CURSOR_SECURITY_FIXTURE") != "1" {
		return
	}
	switch os.Getenv("PAIRFOB_CURSOR_SECURITY_RESULT") {
	case "ok":
		fmt.Print("saved-access-token\n")
	case "max":
		fmt.Print(strings.Repeat("x", cursorQuotaTokenLimit) + "\n")
	case "missing":
		os.Exit(44)
	case "denied":
		fmt.Print("partial-secret")
		fmt.Fprint(os.Stderr, "private credential text")
		os.Exit(36)
	case "oversized":
		fmt.Print(strings.Repeat("x", cursorQuotaTokenLimit+2))
	case "empty":
		fmt.Print("\n")
	case "blocked":
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func TestCursorQuotaSecurityReadIsBoundedAndFailsClosed(t *testing.T) {
	t.Setenv("PAIRFOB_CURSOR_SECURITY_FIXTURE", "1")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ result, status string }{
		{"ok", ""}, {"max", ""}, {"missing", "not_logged_in"}, {"denied", "auth_required"},
		{"oversized", "auth_required"}, {"empty", "auth_required"}, {"blocked", "auth_required"},
	} {
		t.Run(tc.result, func(t *testing.T) {
			t.Setenv("PAIRFOB_CURSOR_SECURITY_RESULT", tc.result)
			ctx := context.Background()
			if tc.result == "blocked" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
				defer cancel()
			}
			start := time.Now()
			token, status := runCursorQuotaKeychain(ctx, binary, "-test.run=^TestCursorQuotaSecurityProcess$")
			if status != tc.status {
				t.Fatalf("status=%q, want %q", status, tc.status)
			}
			if tc.result == "ok" {
				if token != "saved-access-token" {
					t.Fatal("credential bytes changed")
				}
			} else if tc.result == "max" {
				if len(token) != cursorQuotaTokenLimit {
					t.Fatal("maximum credential was truncated")
				}
			} else if token != "" {
				t.Fatal("failed process leaked credential output")
			}
			if tc.result == "blocked" && time.Since(start) > 2*time.Second {
				t.Fatal("credential reader ignored cancellation")
			}
		})
	}
}
