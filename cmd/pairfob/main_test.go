package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
	"pairfob/internal/wsnet"
)

func TestOfferPairingOnStartOnlyWhenAsked(t *testing.T) {
	if offerPairingOnStart(0, "") {
		t.Fatal("background start must not mint a pairing code")
	}
	if offerPairingOnStart(1, "") {
		t.Fatal("restart with a paired phone must not mint a new code")
	}
	if !offerPairingOnStart(2, "7K3M9H2P") {
		t.Fatal("PAIRFOB_PAIR_CODE is an explicit request to open a slot")
	}
}

func TestAnnounceStartupSkipsPairingWhenAPhoneExists(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	eng.PutDevice("dev_12345678", []byte("01234567890123456789012345678901"))
	if err := announceStartup(eng, "/tmp/s", ""); err != nil {
		t.Fatal(err)
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("paired restart opened a pairing slot")
	}
}

func TestAnnounceStartupStaysQuietWhenUnpaired(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	if err := announceStartup(eng, "/tmp/s", ""); err != nil {
		t.Fatal(err)
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("unpaired background start opened a pairing slot")
	}
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

func startLiveAdmin(t *testing.T, eng *daemon.Engine) string {
	t.Helper()
	sock := testSocket(t)
	ln, err := admin.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = admin.Serve(ln, liveAdmin{eng: eng})
		close(done)
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return sock
}

type interactiveAdmin struct {
	status admin.Pairing
	steps  []string
	mu     sync.Mutex
}

func (a *interactiveAdmin) Status() admin.Pairing {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.status
}
func (a *interactiveAdmin) NewPairing() (admin.Pairing, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steps = append(a.steps, "new")
	a.status = admin.Pairing{
		Ref: "4f7a2c9e1b0d88aa55cc3311abde7001", Code: "7K3M9H2P",
		URL:       "https://pairfob.example/pair#c=7K3M9H2P&d=d_test&fp=AAAAAAAAAAAAAAAAAAAAAA&r=4f7a2c9e1b0d88aa55cc3311abde7001&v=1",
		ExpiresAt: time.Now().Add(time.Minute),
	}
	return a.status, nil
}
func (a *interactiveAdmin) WaitPairingReady(ref string) (admin.Pairing, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steps = append(a.steps, "wait:"+ref)
	a.status.Ready = true
	return a.status, nil
}
func (a *interactiveAdmin) Admit(ref string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steps = append(a.steps, "accept:"+ref)
	return nil
}
func (a *interactiveAdmin) Deny(ref string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steps = append(a.steps, "deny:"+ref)
	return nil
}
func (a *interactiveAdmin) Devices() []admin.Device     { return nil }
func (a *interactiveAdmin) Revoke(string) error         { return nil }
func (a *interactiveAdmin) Rekey() (admin.Relay, error) { return admin.Relay{}, nil }
func (a *interactiveAdmin) Steps() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.steps...)
}

func startAdminService(t *testing.T, svc admin.Service) string {
	t.Helper()
	sock := testSocket(t)
	ln, err := admin.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = admin.Serve(ln, svc)
		close(done)
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return sock
}

func TestRelayLinkDropsOfflineFramesAcrossReconnect(t *testing.T) {
	received := make(chan envelope.Frame, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := wsnet.UpgraderFor(wsnet.SubprotocolV2)
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := wsnet.Wrap(ws)
		defer conn.Close()
		frame, err := conn.Recv()
		if err == nil {
			received <- frame
		}
	}))
	defer server.Close()

	engineSide, relaySide := mux.NewPipePair(16)
	link := newRelayLink(relaySide)
	go link.sendLoop()
	defer engineSide.Close()
	if err := engineSide.Send(envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: []byte("offline")}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	conn, err := wsnet.DialProtocol("ws"+strings.TrimPrefix(server.URL, "http"), wsnet.SubprotocolV2)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	link.set(conn)
	if err := engineSide.Send(envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: []byte("online")}); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-received:
		if string(frame.Payload) != "online" {
			t.Fatalf("offline frame crossed reconnect: %q", frame.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("online frame was not delivered")
	}
}

func TestRelayHeartbeatKeepsIdleConnectionActive(t *testing.T) {
	sender, receiver := mux.NewPipePair(4)
	defer sender.Close()
	defer receiver.Close()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		runRelayHeartbeat(sender, time.Millisecond, stop)
		close(done)
	}()

	for want := uint64(1); want <= 2; want++ {
		frame, ok := receiver.RecvTimeout(time.Second)
		if !ok {
			t.Fatal("heartbeat was not sent")
		}
		if frame.Version != 1 || frame.Typ != envelope.TypPING || frame.RouteID != ([16]byte{}) || len(frame.Payload) != 8 {
			t.Fatalf("invalid heartbeat frame: %+v", frame)
		}
		if got := binary.BigEndian.Uint64(frame.Payload); got != want {
			t.Fatalf("heartbeat counter=%d want=%d", got, want)
		}
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("heartbeat loop did not stop")
	}
}

func TestDeviceAdminNeverReturnsCredentials(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.PutDevice("dev_12345678", []byte("01234567890123456789012345678901"))
	eng.Devices["dev_12345678"].UA = "private-user-agent"
	eng.Devices["dev_12345678"].PushSubscriptions = []state.PushSubscription{{
		Endpoint: "https://push.example.test/private-token", P256DH: "private-key", Auth: "private-auth",
	}}
	sock := startLiveAdmin(t, eng)
	resp, err := admin.Call(sock, admin.Request{Op: "device.list"})
	if err != nil {
		t.Fatal(err)
	}
	body := string(resp.Result)
	for _, forbidden := range []string{"device_psk", "0123456789", "private-user-agent", "private-token", "private-key", "private-auth"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("admin response leaked %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"device_id":"dev_12345678"`) || !strings.Contains(body, `"subscription_count":1`) {
		t.Fatalf("missing safe summary fields: %s", body)
	}
}

func TestPairNewReturnsFreshCodesToTheLocalOperator(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	sock := startLiveAdmin(t, eng)
	resp, err := admin.Call(sock, admin.Request{Op: "pair.new"})
	if err != nil {
		t.Fatal(err)
	}
	status := eng.PairingStatus()
	if status.Ref == "" || status.Code == "" || status.URL == "" {
		t.Fatalf("ref=%t code=%t url=%t", status.Ref != "", status.Code != "", status.URL != "")
	}
	body := string(resp.Result)
	if !strings.Contains(body, status.Code) || !strings.Contains(body, `"code"`) ||
		!strings.Contains(body, `"pair_url"`) || !strings.Contains(body, `"expires_at"`) {
		t.Fatal("pair new response did not return the fresh pairing offer to the local operator")
	}
}

func TestUnknownAdminOpIsRejected(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	sock := startLiveAdmin(t, eng)
	_, err := admin.Call(sock, admin.Request{Op: "pair.confirm"})
	if err == nil || err.Error() != "unknown_op" {
		t.Fatalf("got %v", err)
	}
}

func TestCLIPairAcceptRequiresRunningDaemon(t *testing.T) {
	sock := testSocket(t)
	err := runCommand([]string{"pair", "accept"}, sock)
	if err == nil || !strings.Contains(err.Error(), "isn't running") {
		t.Fatalf("got %v", err)
	}
}

func TestInteractivePairWaitsForProofThenAcceptsEnter(t *testing.T) {
	svc := &interactiveAdmin{}
	sock := startAdminService(t, svc)
	var out bytes.Buffer
	if err := runInteractivePairing(context.Background(), sock, strings.NewReader("\n"), &out); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"new",
		"wait:4f7a2c9e1b0d88aa55cc3311abde7001",
		"accept:4f7a2c9e1b0d88aa55cc3311abde7001",
	}
	steps := svc.Steps()
	if strings.Join(steps, "|") != strings.Join(want, "|") {
		t.Fatalf("steps=%v", steps)
	}
	text := out.String()
	if !strings.Contains(text, "Waiting to pair") || !strings.Contains(text, "Press Enter to pair") || !strings.Contains(text, "Paired.") {
		t.Fatalf("interactive output=%s", text)
	}
	if !strings.Contains(text, ">>>  Press Enter to pair  <<<") {
		t.Fatalf("enter prompt was not a standalone CTA: %s", text)
	}
	if strings.Contains(strings.ToLower(text), "sas") || strings.Contains(text, "two words") {
		t.Fatalf("interactive pairing showed SAS: %s", text)
	}
}

func TestInteractivePairEOFDeniesTheExactSlot(t *testing.T) {
	svc := &interactiveAdmin{}
	sock := startAdminService(t, svc)
	err := runInteractivePairing(context.Background(), sock, strings.NewReader(""), &bytes.Buffer{})
	if err == nil || err.Error() != "pairing cancelled" {
		t.Fatalf("got %v", err)
	}
	steps := svc.Steps()
	last := steps[len(steps)-1]
	if last != "deny:4f7a2c9e1b0d88aa55cc3311abde7001" {
		t.Fatalf("steps=%v", steps)
	}
}

func TestLiveAdminStatusJSONHasNoDeviceSecrets(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	svc := liveAdmin{eng: eng}
	body, err := json.Marshal(svc.Status())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "device_psk") {
		t.Fatalf("status leaked psk: %s", body)
	}
}
