package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestServiceLockHelper(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_INSTALL_LEASE") == "" {
		return
	}
	layout, err := currentServiceLayout()
	if err != nil {
		t.Fatal(err)
	}
	lock, err := openServiceLock(layout)
	if err != nil {
		t.Fatal("inherited lock:", err)
	}
	lock.Close()
	// Closing a nested borrowed handle must not unlock the parent's transaction.
	t.Setenv(inheritedServiceLock, "")
	if unexpected, err := openServiceLock(layout); err == nil {
		unexpected.Close()
		t.Fatal("installer transaction was unlocked")
	}
}

func TestInstallerSharesOneLockWithNestedCommands(t *testing.T) {
	layout, _ := lifecycleFixture(t)
	t.Setenv("PAIRFOB_TEST_INSTALL_LEASE", "1")
	if err := runInstallerLocked([]string{os.Args[0], "-test.run=^TestServiceLockHelper$"}); err != nil {
		t.Fatal(err)
	}
	lock, err := openServiceLock(layout)
	if err != nil {
		t.Fatal("installer did not release control:", err)
	}
	lock.Close()
}

func TestConcurrentReconcileCannotStopVerifiedSuccessor(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	child := startLifecycleChild(t, layout.StateDir, sock, version, false)
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		if args[1] != "print" && (len(args) < 3 || args[2] != "show") {
			t.Errorf("unexpected mutation: %v", args)
		}
		once.Do(func() { close(entered); <-resume })
		return fakeManagerOutput(layout, child.cmd.Process.Pid), nil
	})
	done := make(chan error, 1)
	go func() { done <- ensureInstalledService(layout, false) }()
	<-entered
	err := ensureInstalledService(layout, true)
	close(resume)
	if err == nil || !strings.Contains(err.Error(), "another Pairfob") {
		t.Fatalf("concurrent restart interleaved: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first reconciliation did not complete")
	}
	select {
	case <-child.done:
		t.Fatal("successor was stopped")
	default:
	}
}

func TestServiceLockRejectsUnsafeLockPathAndForgedInheritance(t *testing.T) {
	layout, _ := lifecycleFixture(t)
	t.Setenv(inheritedServiceLock, "3")
	first, err := openServiceLock(layout)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := openServiceLock(layout); err == nil {
		second.Close()
		t.Fatal("environment bypassed control lock")
	}
	first.Close()
	path := layout.UnitPath + ".control-lock"
	os.Remove(path)
	target := filepath.Join(layout.StateDir, "unrelated")
	os.WriteFile(target, []byte("keep"), 0600)
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if lock, err := openServiceLock(layout); err == nil {
		lock.Close()
		t.Fatal("followed lock symlink")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "keep" {
		t.Fatal("modified symlink target")
	}
}

func TestPrepareInstallPreservesRecoverableDefinition(t *testing.T) {
	layout, _ := lifecycleFixture(t)
	before, err := os.ReadFile(layout.UnitPath)
	if err != nil {
		t.Fatal(err)
	}
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		if args[1] == "print" || len(args) > 2 && args[2] == "show" {
			return fakeManagerOutput(layout, 12345), nil
		}
		if args[1] == "bootout" || len(args) > 2 && args[2] == "stop" {
			return nil, nil
		}
		t.Errorf("preflight removed service: %v", args)
		return nil, nil
	})
	if err := prepareServiceInstall(layout); err != nil {
		t.Fatal(err)
	}
	// A later download replacement/enroll failure must leave the definition
	// available for an explicit service start, preserving its environment too.
	after, err := os.ReadFile(layout.UnitPath)
	if err != nil || string(before) != string(after) {
		t.Fatalf("lost service definition: %v", err)
	}
}
