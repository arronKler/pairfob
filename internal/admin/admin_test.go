package admin

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fake struct {
	status   Pairing
	devices  []Device
	newErr   error
	waitErr  error
	admit    error
	deny     error
	revoke   error
	opened   int
	waited   string
	admitted string
	denied   string
	revoked  string
}

func (f *fake) Status() Pairing { return f.status }
func (f *fake) NewPairing() (Pairing, error) {
	f.opened++
	if f.newErr != nil {
		return Pairing{}, f.newErr
	}
	f.status = Pairing{
		Ref: "4f7a2c9e1b0d88aa55cc3311abde7001", Code: "7K3M9H2P",
		URL: "https://pairfob.example/pair#c=7K3M9H2P", Devices: f.status.Devices,
		ExpiresAt: time.Now().Add(time.Minute), Host: "box", Runtime: "herdr",
	}
	return f.status, nil
}
func (f *fake) WaitPairingReady(ref string) (Pairing, error) {
	f.waited = ref
	if f.waitErr != nil {
		return Pairing{}, f.waitErr
	}
	f.status.Ready = true
	return f.status, nil
}
func (f *fake) Admit(ref string) error {
	f.admitted = ref
	return f.admit
}
func (f *fake) Deny(ref string) error {
	f.denied = ref
	return f.deny
}
func (f *fake) Devices() []Device { return f.devices }
func (f *fake) Revoke(id string) error {
	f.revoked = id
	return f.revoke
}
func (f *fake) Rekey() (Relay, error) {
	return Relay{URL: "wss://pairfob.test/v2/ws", Protocol: 2}, nil
}

func testSocket(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "s")
}

func start(t *testing.T, svc Service) string {
	t.Helper()
	sock := testSocket(t)
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = Serve(ln, svc)
		close(done)
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return sock
}

func TestSocketPathMustBeAbsolute(t *testing.T) {
	t.Setenv("PAIRFOB_ADMIN_SOCK", "relative.sock")
	if _, err := SocketPath(); err == nil {
		t.Fatal("relative override accepted")
	}
	override := filepath.Join(t.TempDir(), "pairfobd.sock")
	t.Setenv("PAIRFOB_ADMIN_SOCK", override)
	got, err := SocketPath()
	if err != nil || got != override {
		t.Fatalf("got %q %v", got, err)
	}
	fromDir, err := SocketPathIn(filepath.Join(t.TempDir(), "other"))
	if err != nil || fromDir != override {
		t.Fatalf("env must win over state dir: %q %v", fromDir, err)
	}
}

func TestRekeyUsesTheLongControlPlaneDeadline(t *testing.T) {
	if timeoutFor("relay.rekey") != rekeyTimeout || timeoutFor("pair.wait") != pairWaitTimeout || timeoutFor("pair.status") != adminTimeout {
		t.Fatalf("unexpected deadlines rekey=%s wait=%s status=%s", timeoutFor("relay.rekey"), timeoutFor("pair.wait"), timeoutFor("pair.status"))
	}
}

func TestSocketPathInResolvesRelativeStateDir(t *testing.T) {
	t.Setenv("PAIRFOB_ADMIN_SOCK", "")
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
	got, err := SocketPathIn("state")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) || filepath.Base(got) != socketName || !strings.HasSuffix(got, filepath.Join("state", socketName)) {
		t.Fatalf("got %q", got)
	}
}

func TestListenRejectsALiveDaemonAndReplacesAStaleSocket(t *testing.T) {
	svc := &fake{}
	sock := start(t, svc)
	if _, err := Listen(sock); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("live socket: %v", err)
	}
	stale := testSocket(t)
	if err := os.WriteFile(stale, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	ln, err := Listen(stale)
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
}

func TestListenModeIsOwnerOnly(t *testing.T) {
	sock := testSocket(t)
	ln, err := Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	info, err := os.Lstat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("not a socket: %s", info.Mode())
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("socket mode %o", info.Mode().Perm())
	}
}

func TestPairAndDeviceOps(t *testing.T) {
	svc := &fake{
		status: Pairing{Ref: "abc", Ready: true, Host: "box", Runtime: "herdr"},
		devices: []Device{{
			ID: "dev_12345678", Label: "iPhone", SubscriptionCount: 1,
		}},
	}
	sock := start(t, svc)

	status, err := Call(sock, Request{Op: "pair.status"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(status.Result), `"sas"`) || strings.Contains(string(status.Result), "device_psk") {
		t.Fatalf("status=%s", status.Result)
	}
	ready, err := Call(sock, Request{Op: "pair.wait", PairRef: "abc"})
	if err != nil || svc.waited != "abc" || !strings.Contains(string(ready.Result), `"ready":true`) {
		t.Fatalf("wait ready: err=%v waited=%q result=%s", err, svc.waited, ready.Result)
	}

	if _, err := Call(sock, Request{Op: "pair.accept"}); err != nil || svc.admitted != "abc" {
		t.Fatalf("accept current slot: err=%v admitted=%q", err, svc.admitted)
	}
	offer, err := Call(sock, Request{Op: "pair.new"})
	if err != nil || svc.opened != 1 {
		t.Fatalf("pair.new err=%v opened=%d", err, svc.opened)
	}
	if !strings.Contains(string(offer.Result), `"code":"7K3M9H2P"`) || !strings.Contains(string(offer.Result), `"pair_url"`) {
		t.Fatalf("offer=%s", offer.Result)
	}
	if _, err := Call(sock, Request{Op: "pair.deny"}); err != nil || svc.denied != "4f7a2c9e1b0d88aa55cc3311abde7001" {
		t.Fatalf("deny current slot: err=%v denied=%q", err, svc.denied)
	}

	list, err := Call(sock, Request{Op: "device.list"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(list.Result), `"device_id":"dev_12345678"`) ||
		!strings.Contains(string(list.Result), `"subscription_count":1`) ||
		strings.Contains(string(list.Result), "device_psk") {
		t.Fatalf("list=%s", list.Result)
	}
	if _, err := Call(sock, Request{Op: "device.revoke", DeviceID: "dev_12345678"}); err != nil || svc.revoked != "dev_12345678" {
		t.Fatalf("revoke: err=%v id=%q", err, svc.revoked)
	}
	rekey, err := Call(sock, Request{Op: "relay.rekey"})
	if err != nil || !strings.Contains(string(rekey.Result), `"protocol":2`) || strings.Contains(string(rekey.Result), "reconnect_token") {
		t.Fatalf("rekey=%s err=%v", rekey.Result, err)
	}
}

func TestDispatchErrors(t *testing.T) {
	svc := &fake{admit: errors.New("pairing closed")}
	sock := start(t, svc)
	if _, err := Call(sock, Request{Op: "nope"}); err == nil || err.Error() != "unknown_op" {
		t.Fatalf("unknown op: %v", err)
	}
	if _, err := Call(sock, Request{Op: "pair.accept"}); err == nil || err.Error() != "no active pairing" {
		t.Fatalf("accept empty: %v", err)
	}
	if _, err := Call(sock, Request{Op: "pair.wait"}); err == nil || err.Error() != "pair_ref required" {
		t.Fatalf("wait missing ref: %v", err)
	}
	svc.status.Ref = "abc"
	if _, err := Call(sock, Request{Op: "pair.accept"}); err == nil || err.Error() != "pairing closed" {
		t.Fatalf("admit failure: %v", err)
	}
	if _, err := Call(sock, Request{Op: "device.revoke"}); err == nil || err.Error() != "device_id required" {
		t.Fatalf("revoke missing id: %v", err)
	}
	if _, err := Call(sock, Request{Op: "pair.new"}); err != nil {
		t.Fatal(err)
	}
}

func TestCallWithoutDaemon(t *testing.T) {
	sock := testSocket(t)
	_, err := Call(sock, Request{Op: "pair.status"})
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("got %v", err)
	}
}

func TestJSONRoundTripOmitsSecretsFromWire(t *testing.T) {
	body, err := json.Marshal(Device{ID: "dev_1", Label: "phone", SubscriptionCount: 2})
	if err != nil {
		t.Fatal(err)
	}
	raw := string(body)
	for _, leak := range []string{"psk", "ua", "endpoint", "p256dh", "auth"} {
		if strings.Contains(strings.ToLower(raw), leak) {
			t.Fatalf("device summary leaked %q: %s", leak, raw)
		}
	}
}

func TestServeRequiresService(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := Serve(ln, nil); err == nil {
		t.Fatal("nil service accepted")
	}
}
