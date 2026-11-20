//go:build darwin && cgo

package remotedesktop

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDesktopAudioStopsBeforeNextCaptureCallback(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "audio-failure")
	cmd := exec.Command("xcrun", "clang", "-fblocks", "testdata/audio_failure.m", "-framework", "Cocoa", "-framework", "CoreMedia", "-framework", "AudioToolbox", "-o", exe)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile: %v: %s", err, out)
	}
	if out, err := exec.Command(exe).CombinedOutput(); err != nil {
		t.Fatalf("audio shutdown: %v: %s", err, out)
	}
}
