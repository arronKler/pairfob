package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"pairfob/internal/daemon"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestUpdateProcessHelper(t *testing.T) {
	mode := os.Getenv("PAIRFOB_UPDATE_TEST_MODE")
	if mode == "" {
		return
	}
	dir := os.Getenv("PAIRFOB_UPDATE_TEST_DIR")
	t.Setenv("HOME", dir)
	if mode == "install" {
		u := &remoteUpdater{dir: dir, dest: filepath.Join(dir, "installed"), base: os.Getenv("PAIRFOB_UPDATE_TEST_URL"), job: daemon.UpdateStatus{Phase: "downloading", Target: "1.1.0"}}
		if err := u.install("1.1.0"); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := beginUpdateBoot(dir); err != nil {
			t.Fatal(err)
		}
	}
	t.Fatal("expected process replacement")
}
func TestUpdateActuallyExecsVerifiedCandidate(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "installed")
	if err := os.WriteFile(dest, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo 'pairfob 1.1.0 test/test'; else echo 'candidate-running'; fi\n")
	server := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "1.1.0", payload))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestUpdateProcessHelper$")
	cmd.Env = append(os.Environ(), "PAIRFOB_UPDATE_TEST_MODE=install", "PAIRFOB_UPDATE_TEST_DIR="+dir, "PAIRFOB_UPDATE_TEST_URL="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "candidate-running") {
		t.Fatalf("%v %s", err, out)
	}
	if candidates, _ := filepath.Glob(filepath.Join(dir, ".pairfob-candidate-*")); len(candidates) != 0 {
		t.Fatalf("candidate leak: %v", candidates)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "daemon-update-backup"))
	if string(b) != "old" {
		t.Fatal("backup missing")
	}
}
func TestFailedBootActuallyExecsVerifiedBackup(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "failed-daemon")
	current, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(dest, current, 0755); err != nil {
		t.Fatal(err)
	}
	previous := []byte("#!/bin/sh\necho 'previous-version-running'\n")
	u := &remoteUpdater{dir: dir, dest: dest, candidateHash: sha256Hex(current), backupHash: sha256Hex(previous), job: daemon.UpdateStatus{Phase: "verifying", Target: "1.1.0"}}
	if err = os.WriteFile(u.backupPath(), previous, 0755); err != nil {
		t.Fatal(err)
	}
	if err = u.save(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(dest+".update-pending", []byte(u.jobPath()), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, dest, "-test.run=^TestUpdateProcessHelper$")
	cmd.Env = append(os.Environ(), "PAIRFOB_UPDATE_TEST_MODE=rollback", "PAIRFOB_UPDATE_TEST_DIR="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "previous-version-running") {
		t.Fatalf("%v %s", err, out)
	}
	raw, _ := os.ReadFile(u.jobPath())
	var status daemon.UpdateStatus
	if json.Unmarshal(raw, &status) != nil || status.Phase != "rolled_back" {
		t.Fatalf("%s", raw)
	}
}

func TestBootCleansPendingAfterInterruptedFinalization(t *testing.T) {
	for _, phase := range []string{"complete", "failed", "rolled_back", "restarting"} {
		t.Run(phase, func(t *testing.T) {
			dir := t.TempDir()
			dest := filepath.Join(dir, "daemon")
			binary, err := os.ReadFile(os.Args[0])
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(dest, binary, 0755); err != nil {
				t.Fatal(err)
			}
			u := &remoteUpdater{dir: dir, dest: dest, job: daemon.UpdateStatus{Phase: phase, Target: "not-the-running-test-version"}}
			if err = u.save(); err != nil {
				t.Fatal(err)
			}
			os.WriteFile(dest+".update-pending", []byte(u.jobPath()), 0600)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, dest, "-test.run=^TestUpdateCleanupHelper$")
			cmd.Env = append(os.Environ(), "PAIRFOB_UPDATE_TEST_DIR="+dir)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v %s", err, out)
			}
			if _, err = os.Stat(dest + ".update-pending"); !os.IsNotExist(err) {
				t.Fatal("marker survived finalization")
			}
		})
	}
}
func TestUpdateCleanupHelper(t *testing.T) {
	dir := os.Getenv("PAIRFOB_UPDATE_TEST_DIR")
	if dir == "" {
		return
	}
	done, err := beginUpdateBoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = done(); err != nil {
		t.Fatal(err)
	}
}
