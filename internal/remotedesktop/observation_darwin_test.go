//go:build darwin && cgo

package remotedesktop

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDesktopIdleCaptureFreshnessAndPixelChanges(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "idle-capture")
	cmd := exec.Command("xcrun", "clang", "-fblocks", "testdata/idle_capture.m", "probe_darwin.m", "-framework", "Cocoa", "-framework", "CoreMedia", "-framework", "CoreVideo", "-framework", "VideoToolbox", "-framework", "ScreenCaptureKit", "-o", exe)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile: %v: %s", err, out)
	}
	if out, err := exec.Command(exe).CombinedOutput(); err != nil {
		t.Fatalf("native capture observation: %v: %s", err, out)
	}
}
