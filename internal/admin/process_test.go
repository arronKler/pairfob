package admin

import (
	"errors"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type processFake struct {
	fake
	info  ProcessInfo
	stops atomic.Int32
	stop  func()
}

func (f *processFake) ProcessInfo() ProcessInfo { return f.info }
func (f *processFake) StopProcess() {
	f.stops.Add(1)
	if f.stop != nil {
		f.stop()
	}
}

func TestProcessStopIsInstanceBoundAndAcknowledged(t *testing.T) {
	sock := testSocket(t)
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &processFake{info: ProcessInfo{PID: os.Getpid(), Version: "1.2.3", Instance: strings.Repeat("ab", 16)}}
	f.stop = func() { ln.Close() }
	go Serve(ln, f)
	for _, instance := range []string{"", strings.Repeat("cd", 16)} {
		if _, err := Call(sock, Request{Op: "daemon.stop", Instance: instance}); err == nil {
			t.Fatal("accepted another instance")
		}
		if f.stops.Load() != 0 {
			t.Fatal("stopped wrong instance")
		}
	}
	peer, err := OpenPeer(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if peer.PID != os.Getpid() || peer.UID != uint32(os.Getuid()) {
		t.Fatalf("wrong kernel peer: %+v", peer)
	}
	response, err := peer.Request(Request{Op: "daemon.info"})
	if err != nil || !response.OK || !strings.Contains(string(response.Result), "1.2.3") {
		t.Fatalf("%+v %v", response, err)
	}
	response, err = Call(sock, Request{Op: "daemon.stop", Instance: f.info.Instance})
	if err != nil || !response.OK {
		t.Fatalf("stop acknowledgement lost: %+v %v", response, err)
	}
	deadline := time.Now().Add(time.Second)
	for f.stops.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if f.stops.Load() != 1 {
		t.Fatal("did not stop")
	}
}

func TestListenerRejectsNonSocketAndConcurrentDaemon(t *testing.T) {
	sock := testSocket(t)
	if err := os.WriteFile(sock, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if ln, err := Listen(sock); err == nil {
		ln.Close()
		t.Fatal("removed regular file")
	}
	b, _ := os.ReadFile(sock)
	if string(b) != "keep" {
		t.Fatal("changed existing file")
	}
	os.Remove(sock)
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if second, err := Listen(sock); err == nil {
		second.Close()
		t.Fatal("accepted second daemon")
	}
}

func TestListenerClosePreservesSuccessorSocket(t *testing.T) {
	sock := testSocket(t)
	old, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(sock); err != nil {
		t.Fatal(err)
	}
	next, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("unix", sock, time.Second)
	if err != nil {
		t.Fatalf("old cleanup removed successor: %v", err)
	}
	conn.Close()
}

func TestListenerReclaimsOwnedStaleSocket(t *testing.T) {
	sock := testSocket(t)
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	os.Chmod(sock, 0600)
	stale.Close()
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	if _, err := os.Lstat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket not removed: %v", err)
	}
}
