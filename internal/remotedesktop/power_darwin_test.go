//go:build darwin && cgo

package remotedesktop

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestNativeStandbyAssertion(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_MACOS_STANDBY") != "1" {
		t.Skip("set PAIRFOB_TEST_MACOS_STANDBY=1 to check macOS power assertions")
	}
	check := func(want bool) {
		t.Helper()
		until := time.Now().Add(3 * time.Second)
		for {
			out, err := exec.Command("/usr/bin/pmset", "-g", "assertions").Output()
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, fmt.Sprintf("pid %d(", os.Getpid())) &&
					strings.Contains(line, "Pairfob unattended desktop on AC power") {
					found = true
				}
			}
			if found == want {
				return
			}
			if time.Now().After(until) {
				t.Fatalf("timed out waiting for native assertion present=%t", want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	check(false)
	release, err := acquireStandby()
	if err != nil {
		t.Fatal(err)
	}
	func() {
		defer release()
		check(true)
	}()
	check(false)
}
