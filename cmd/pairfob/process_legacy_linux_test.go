package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLegacyLinuxAdoptsDeletedExecutable(t *testing.T) {
	layout, _ := lifecycleFixture(t)
	// Exercise canonical state paths and a Unix socket name with repeated spaces.
	dir := filepath.Join(layout.StateDir, "state  space")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	layout.StateDir = dir
	sock := filepath.Join(dir, "admin  socket")
	t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
	image, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	layout.ExecPath = filepath.Join(dir, "pairfob")
	if err := os.WriteFile(layout.ExecPath, image, 0700); err != nil {
		t.Fatal(err)
	}
	child := startLifecycleExecutable(t, layout.ExecPath, dir, sock, "old", true)
	p, err := inspectLocalProcess(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer p.peer.Close()
	if !p.legacy {
		t.Fatal("expected legacy interface")
	}
	// Atomic replacement leaves /proc/PID/exe referring to the old, deleted inode.
	if err := replaceExecutable(layout.ExecPath, append(image, '\n')); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Readlink("/proc/" + strconv.Itoa(child.cmd.Process.Pid) + "/exe")
	if err != nil || !strings.HasSuffix(exe, " (deleted)") {
		t.Fatalf("exe=%s err=%v", exe, err)
	}
	if err := stopLocalProcess(sock, p, layout); err != nil {
		t.Fatal(err)
	}
	select {
	case <-child.done:
	case <-time.After(time.Second):
		t.Fatal("legacy process survived takeover")
	}
}

func TestLegacyLinuxRefusesOtherIdentityAndChangedSocket(t *testing.T) {
	for _, field := range []string{"uid", "exe", "state", "pid", "successor"} {
		t.Run(field, func(t *testing.T) {
			layout, sock := lifecycleFixture(t)
			child := startLifecycleChild(t, layout.StateDir, sock, "old", true)
			p, err := inspectLocalProcess(sock)
			if err != nil {
				t.Fatal(err)
			}
			defer p.peer.Close()
			switch field {
			case "uid":
				p.peer.UID++
			case "exe":
				layout.ExecPath = "/different/pairfob"
			case "state":
				layout.StateDir = "/different/state"
			case "pid":
				p.peer.PID++
			case "successor":
				child.cmd.Process.Kill()
				<-child.done
				child = startLifecycleChild(t, layout.StateDir, sock, "successor", true)
			}
			if err := stopLegacyProcess(sock, p.peer, layout); err == nil {
				t.Fatal("accepted changed " + field)
			}
			select {
			case <-child.done:
				t.Fatal("unrelated process was stopped")
			default:
			}
		})
	}
}
