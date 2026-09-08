package main

import (
	"errors"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"pairfob/internal/admin"
)

type lifecycleAdmin struct{ liveAdmin }

func (a lifecycleAdmin) Status() admin.Pairing { return admin.Pairing{Devices: 1} }

func TestLifecycleProcessHelper(t *testing.T) {
	dir := os.Getenv("PAIRFOB_LIFECYCLE_TEST_DIR")
	if dir == "" {
		return
	}
	version = os.Getenv("PAIRFOB_LIFECYCLE_TEST_VERSION")
	info, err := newProcessInfo(dir)
	if err != nil {
		t.Fatal(err)
	}
	sock, err := admin.SocketPathIn(dir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := admin.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	a := lifecycleAdmin{liveAdmin{process: info, stop: func() { ln.Close() }}}
	var service admin.Service = a
	if os.Getenv("PAIRFOB_LIFECYCLE_TEST_LEGACY") == "1" {
		service = struct{ admin.Service }{a}
	}
	err = admin.Serve(ln, service)
	if err != nil && !errors.Is(err, net.ErrClosed) {
		t.Fatal(err)
	}
}

type lifecycleChild struct {
	cmd  *exec.Cmd
	done chan error
}

func startLifecycleChild(t *testing.T, dir, sock, build string, legacy bool) *lifecycleChild {
	t.Helper()
	return startLifecycleExecutable(t, os.Args[0], dir, sock, build, legacy)
}

func startLifecycleExecutable(t *testing.T, executable, dir, sock, build string, legacy bool) *lifecycleChild {
	t.Helper()
	cmd := exec.Command(executable, "-test.run=^TestLifecycleProcessHelper$")
	cmd.Env = append(os.Environ(), "PAIRFOB_LIFECYCLE_TEST_DIR="+dir, "PAIRFOB_LIFECYCLE_TEST_VERSION="+build, "PAIRFOB_ADMIN_SOCK="+sock, "PAIRFOB_STATE_DIR="+dir)
	if legacy {
		cmd.Env = append(cmd.Env, "PAIRFOB_LIFECYCLE_TEST_LEGACY=1")
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	child := &lifecycleChild{cmd: cmd, done: make(chan error, 1)}
	go func() { child.done <- cmd.Wait(); close(child.done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-child.done })
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p, err := inspectLocalProcess(sock); err == nil {
			p.peer.Close()
			if p.peer.PID == cmd.Process.Pid {
				return child
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("process did not bind its socket")
	return nil
}

func lifecycleFixture(t *testing.T) (serviceLayout, string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pfr-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	sock := filepath.Join(dir, "pairfob.sock")
	t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
	layout, err := currentServiceLayout()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.UnitPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(layout.UnitPath, []byte(unitBody(layout)), 0600); err != nil {
		t.Fatal(err)
	}
	return layout, sock
}

func fakeManagerOutput(layout serviceLayout, pid int) []byte {
	if layout.GOOS == "linux" {
		state, sub := "inactive", "dead"
		if pid > 0 {
			state, sub = "active", "running"
		}
		return []byte(fmt.Sprintf("MainPID=%d\nActiveState=%s\nSubState=%s\nResult=success\nExecMainStatus=0\nExecStart={ path=%s ; argv[]=%s ; }\n", pid, state, sub, layout.ExecPath, layout.ExecPath))
	}
	return []byte(fmt.Sprintf("service = {\n program = %s\n state = running\n pid = %d\n}\n", layout.ExecPath, pid))
}

func TestUpdateMatchingDiskAdoptsIndependentDaemon(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	old := startLifecycleChild(t, layout.StateDir, sock, "old-build", false)
	identity := filepath.Join(layout.StateDir, "daemon.json")
	devices := filepath.Join(layout.StateDir, "devices.json")
	os.WriteFile(identity, []byte("identity sentinel"), 0600)
	os.WriteFile(devices, []byte("paired-device sentinel"), 0600)
	var managed *lifecycleChild
	starts := 0
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		verb := args[1]
		if args[0] == "systemctl" {
			verb = args[2]
		}
		switch verb {
		case "show", "print":
			pid := 0
			if managed != nil {
				pid = managed.cmd.Process.Pid
			}
			if layout.GOOS == "darwin" && pid == 0 {
				return []byte("Could not find service"), errors.New("not loaded")
			}
			return fakeManagerOutput(layout, pid), nil
		case "stop", "bootout":
			if managed != nil {
				managed.cmd.Process.Kill()
				<-managed.done
				managed = nil
			}
		case "start", "bootstrap":
			unlock, err := lockUpdate(layout.ExecPath)
			if err != nil {
				t.Fatalf("new process would fail its journal lock: %v", err)
			}
			unlock()
			starts++
			managed = startLifecycleChild(t, layout.StateDir, sock, "v1.1.0", false)
		case "enable", "kickstart":
		default:
			t.Fatalf("unexpected service command %v", args)
		}
		return nil, nil
	})
	image, err := os.ReadFile(layout.ExecPath)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "v1.1.0", image))
	defer server.Close()
	if err := updateExecutable(layout.ExecPath, server.URL); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-old.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("old daemon survived")
	}
	if managed == nil || starts != 1 {
		t.Fatal("new service was not started once")
	}
	p, err := inspectLocalProcess(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer p.peer.Close()
	if p.info.PID != managed.cmd.Process.Pid || p.info.Version != "v1.1.0" {
		t.Fatalf("wrong runtime: %+v", p.info)
	}
	for path, want := range map[string]string{identity: "identity sentinel", devices: "paired-device sentinel"} {
		b, _ := os.ReadFile(path)
		if string(b) != want {
			t.Fatal("pairing state changed")
		}
	}
	if err := updateExecutable(layout.ExecPath, server.URL); err != nil {
		t.Fatal(err)
	}
	if starts != 1 {
		t.Fatal("idempotent update restarted a verified current daemon")
	}
}

func TestReadinessRejectsDifferentManagerPIDAndImage(t *testing.T) {
	for _, test := range []string{"pid", "image", "version"} {
		t.Run(test, func(t *testing.T) {
			layout, sock := lifecycleFixture(t)
			child := startLifecycleChild(t, layout.StateDir, sock, "v1.1.0", false)
			pid := child.cmd.Process.Pid
			if test == "pid" {
				pid++
			}
			stubServiceRunner(t, func([]string) ([]byte, error) { return fakeManagerOutput(layout, pid), nil })
			want, _ := executableHash(layout.ExecPath)
			if test == "image" {
				want = strings.Repeat("00", 32)
			}
			wantVersion := "v1.1.0"
			if test == "version" {
				wantVersion = "v1.1.1"
			}
			if err := waitForServiceWithin(layout, sock, want, wantVersion, 250*time.Millisecond, 0); err == nil {
				t.Fatal("accepted mismatched runtime")
			}
		})
	}
}

func TestProcessOwnershipRejectsOtherStateAndExecutable(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	startLifecycleChild(t, layout.StateDir, sock, "v1.1.0", false)
	p, err := inspectLocalProcess(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer p.peer.Close()
	for _, field := range []string{"state", "exe"} {
		info := p.info
		if field == "state" {
			info.StateDir = "/other/state"
		} else {
			info.Executable = "/other/pairfob"
		}
		if err := processBelongsTo(info, layout); err == nil {
			t.Fatal("accepted different " + field)
		}
	}
}

func TestRelativeStateDirectoryMatchesAbsoluteRuntime(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(cwd, layout.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PAIRFOB_STATE_DIR", rel)
	got, err := currentServiceLayout()
	if err != nil || !filepath.IsAbs(got.StateDir) {
		t.Fatalf("%+v %v", got, err)
	}
	info, err := newProcessInfo(rel)
	if err != nil || info.StateDir != layout.StateDir {
		t.Fatalf("%+v %v", info, err)
	}
	child := startLifecycleChild(t, layout.StateDir, sock, version, false)
	stubServiceRunner(t, func([]string) ([]byte, error) { return fakeManagerOutput(got, child.cmd.Process.Pid), nil })
	want, _ := executableHash(layout.ExecPath)
	if err := waitForServiceWithin(got, sock, want, version, time.Second, 0); err != nil {
		t.Fatal(err)
	}
}

func TestRunningImageIdentitySurvivesDiskReplacement(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	image, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(layout.StateDir, "pairfob")
	if err := os.WriteFile(exe, image, 0700); err != nil {
		t.Fatal(err)
	}
	startLifecycleExecutable(t, exe, layout.StateDir, sock, version, false)
	before, err := inspectLocalProcess(sock)
	if err != nil {
		t.Fatal(err)
	}
	before.peer.Close()
	if err := replaceExecutable(exe, append(image, '\n')); err != nil {
		t.Fatal(err)
	}
	after, err := inspectLocalProcess(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer after.peer.Close()
	onDisk, err := executableHash(exe)
	if err != nil {
		t.Fatal(err)
	}
	if before.info != after.info || after.info.SHA256 == onDisk {
		t.Fatal("running metadata followed the replaced disk file")
	}
}

func TestReconcileStartsAfterManagedLegacyStops(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	managed := startLifecycleChild(t, layout.StateDir, sock, "legacy", true)
	oldPID := managed.cmd.Process.Pid
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		verb := args[1]
		if args[0] == "systemctl" {
			verb = args[2]
		}
		switch verb {
		case "print", "show":
			if managed == nil {
				if layout.GOOS == "darwin" {
					return []byte("Could not find service"), errors.New("unloaded")
				}
				return fakeManagerOutput(layout, 0), nil
			}
			return fakeManagerOutput(layout, managed.cmd.Process.Pid), nil
		case "stop", "bootout":
			if managed != nil {
				managed.cmd.Process.Kill()
				<-managed.done
				managed = nil
			}
		case "start", "bootstrap":
			managed = startLifecycleChild(t, layout.StateDir, sock, version, false)
		case "enable", "kickstart":
		default:
			t.Fatalf("unexpected command: %v", args)
		}
		return nil, nil
	})
	if err := ensureInstalledService(layout, true); err != nil {
		t.Fatal(err)
	}
	if managed == nil || managed.cmd.Process.Pid == oldPID {
		t.Fatal("legacy service was not replaced")
	}
}
