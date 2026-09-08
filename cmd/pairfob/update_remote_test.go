package main

import (
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"pairfob/internal/daemon"
)

func TestRemoteUpdateDeduplicatesAndRejectsConcurrentMutation(t *testing.T) {
	previous := version
	version = "1.0.0"
	defer func() { version = previous }()
	var calls atomic.Int32
	finish := make(chan struct{})
	done := make(chan struct{})
	u := &remoteUpdater{dir: t.TempDir(), available: true, job: daemon.UpdateStatus{Phase: "idle"}}
	u.run = func(string) error { calls.Add(1); <-finish; close(done); return nil }
	id := "op_abcdefghijklmnop"
	if _, err := u.Start(id, "1.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := u.Start(id, "1.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := u.Start("op_ponmlkjihgfedcba", "1.1.0"); err == nil {
		t.Fatal("accepted competing updater")
	}
	close(finish)
	<-done
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	if _, err := u.Start(id, "../../payload"); err == nil {
		t.Fatal("accepted path")
	}
}
func TestRemoteUpdateExecFailureRestoresPreviousBinary(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	dest := filepath.Join(dir, "pairfob")
	old := []byte("old binary")
	if err := os.WriteFile(dest, old, 0755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("#!/bin/sh\nprintf 'pairfob 1.1.0 test/test\\n'\n")
	server := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "1.1.0", payload))
	defer server.Close()
	u := &remoteUpdater{dir: dir, dest: dest, base: server.URL, job: daemon.UpdateStatus{Phase: "downloading", Target: "1.1.0"}}
	called := false
	err := u.installAndActivate("1.1.0", func(path string, args, env []string) error {
		called = true
		b, _ := os.ReadFile(path)
		if string(b) != string(payload) {
			t.Error("candidate not installed")
		}
		return errors.New("exec failure")
	})
	if err == nil || !called {
		t.Fatalf("err=%v called=%v", err, called)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != string(old) {
		t.Fatal("did not restore previous bytes")
	}
}
func TestRemoteUpdateChangedReleaseDoesNotReplaceBinary(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	dest := filepath.Join(dir, "pairfob")
	os.WriteFile(dest, []byte("old"), 0755)
	server := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "1.2.0", []byte("bad")))
	defer server.Close()
	u := &remoteUpdater{dir: dir, dest: dest, base: server.URL}
	if err := u.install("1.1.0"); err == nil {
		t.Fatal("accepted changed release")
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "old" {
		t.Fatal("changed current binary")
	}
}
func TestUpdateLockSerializesCLIAndRemote(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "pairfob")
	release, err := lockUpdate(dest)
	if err != nil {
		t.Fatal(err)
	}
	if unlock, err := lockUpdate(dest); err == nil {
		unlock()
		t.Fatal("second updater acquired lock")
	}
	release()
	unlock, err := lockUpdate(dest)
	if err != nil {
		t.Fatal(err)
	}
	unlock()
}
func TestUpdateBootCompletePersistsOnlyMatchingRunningVersion(t *testing.T) {
	dir := t.TempDir()
	u := &remoteUpdater{dir: dir, job: daemon.UpdateStatus{Phase: "restarting", Target: version}}
	if err := u.save(); err != nil {
		t.Fatal(err)
	}
	done, err := beginUpdateBoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	done()
	restored := newRemoteUpdater(dir)
	if restored.Status().Phase != "complete" {
		t.Fatal(restored.Status())
	}
}
func TestVersionOrderingRejectsDowngradesAndDevelopmentBuilds(t *testing.T) {
	for _, pair := range [][2]string{{"1.0.0", "2.0.0"}, {"1.1.0", "dev"}, {"1.0.0", "1.0.0"}} {
		if newerVersion(pair[0], pair[1]) {
			t.Fatal(pair)
		}
	}
	if !newerVersion("2026-09-07.10", "2026-09-07.9") {
		t.Fatal("lexical version ordering")
	}
}

func TestPendingCleanupChecksOwnershipAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	u := &remoteUpdater{dir: dir, dest: filepath.Join(dir, "pairfob")}
	marker := u.dest + ".update-pending"
	os.WriteFile(marker, []byte("another-state"), 0600)
	if err := u.clearPending(); err == nil {
		t.Fatal("removed another updater's pending marker")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(marker, []byte(u.jobPath()), 0600)
	if err := u.clearPending(); err != nil {
		t.Fatal(err)
	}
	if err := u.clearPending(); err != nil {
		t.Fatal("cleanup is not idempotent", err)
	}
}
func TestRollbackRefusesExternallyChangedBinary(t *testing.T) {
	dir := t.TempDir()
	u := &remoteUpdater{dir: dir, dest: filepath.Join(dir, "pairfob"), candidateHash: sha256Hex([]byte("candidate")), backupHash: sha256Hex([]byte("backup"))}
	os.WriteFile(u.dest, []byte("external-update"), 0755)
	os.WriteFile(u.backupPath(), []byte("backup"), 0755)
	if err := u.restoreBackup(); err == nil {
		t.Fatal("overwrote external update")
	}
	got, _ := os.ReadFile(u.dest)
	if string(got) != "external-update" {
		t.Fatal("modified external binary")
	}
}
