package mux

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestPairAttachIsExclusiveAndDaemonDropBurnsSlots(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	ref := "4f7a2c9e1b0d88aa55cc3311abde7001"
	h.HandleDaemon(dH, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": daemonID, "pair_ref": ref, "ttl_s": 180,
	}))

	c1A, c1H := NewPipePair(8)
	h.HandleClient(c1H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c1H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1, "pair_ref": ref}))
	if fr, ok := c1A.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("first attach: ok=%v typ=%d", ok, fr.Typ)
	}
	if fr, ok := dA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("daemon attach: ok=%v typ=%d", ok, fr.Typ)
	}

	c2A, c2H := NewPipePair(8)
	h.HandleClient(c2H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c2H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	assertErrorCode(t, c2A, "pair_busy")

	h.DropConn(dH)
	assertErrorCode(t, c1A, "daemon_offline")

	c3A, c3H := NewPipePair(8)
	h.HandleClient(c3H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c3H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1, "pair_ref": ref}))
	assertErrorCode(t, c3A, "unpaired")
}

func TestSessionEstablishedIsValidatedAndForwarded(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)

	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	bound, ok := cA.RecvTimeout(time.Second)
	if !ok || bound.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("session bound: ok=%v typ=%d", ok, bound.Typ)
	}
	_, _ = dA.RecvTimeout(time.Second)
	h.HandleDaemon(dH, envelope.JSON(envelope.TypSESSION_ESTABLISHED, bound.RouteID, map[string]any{
		"v": 1, "route_id": "00000000000000000000000000000000",
	}))
	assertErrorCode(t, dA, "unbound")
	if est, resume := h.BindKindCounts(daemonID); est != 0 || resume != 1 {
		t.Fatalf("route mismatch changed bind counts established=%d resume=%d", est, resume)
	}

	h.HandleDaemon(dH, envelope.JSON(envelope.TypSESSION_ESTABLISHED, bound.RouteID, map[string]any{
		"v": 1, "route_id": fmtRID(bound.RouteID),
	}))
	established, ok := cA.RecvTimeout(time.Second)
	if !ok || established.Typ != envelope.TypSESSION_ESTABLISHED || established.RouteID != bound.RouteID {
		t.Fatalf("established control: ok=%v typ=%d route=%x", ok, established.Typ, established.RouteID)
	}
	if est, resume := h.BindKindCounts(daemonID); est != 1 || resume != 0 {
		t.Fatalf("bind counts established=%d resume=%d", est, resume)
	}
}

func TestPairSlotTTLClosesActiveBind(t *testing.T) {
	h := NewHub("kt")
	h.ttlPair = 20 * time.Millisecond
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	ref := "4f7a2c9e1b0d88aa55cc3311abde7001"
	h.HandleDaemon(dH, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "daemon_id": daemonID, "pair_ref": ref,
	}))
	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1, "pair_ref": ref}))
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("pair attached: ok=%v typ=%d", ok, fr.Typ)
	}
	_, _ = dA.RecvTimeout(time.Second)
	assertErrorCode(t, cA, "unpaired")
}

func TestReconnectRegistrySurvivesRestartWithoutRawToken(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "relay-registry.json")
	h1, err := NewPersistentHub("kt", statePath)
	if err != nil {
		t.Fatal(err)
	}
	d1A, d1H := NewPipePair(8)
	daemonID, reconnectToken, _ := registerTestDaemon(t, h1, d1A, d1H)
	h1.DropConn(d1H)

	state, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(state, []byte(reconnectToken)) {
		t.Fatal("relay state persisted the raw reconnect token")
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("relay state mode = %o", info.Mode().Perm())
	}

	h2, err := NewPersistentHub("new-join", statePath)
	if err != nil {
		t.Fatal(err)
	}
	d2A, d2H := NewPipePair(8)
	h2.HandleDaemon(d2H, envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "daemon_id": daemonID, "reconnect_token": reconnectToken,
	}))
	fr, ok := d2A.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypHELLO_DAEMON {
		t.Fatalf("restart reconnect: ok=%v typ=%d payload=%s", ok, fr.Typ, fr.Payload)
	}
	var response struct {
		OK       bool   `json:"ok"`
		DaemonID string `json:"daemon_id"`
	}
	if err := json.Unmarshal(fr.Payload, &response); err != nil || !response.OK || response.DaemonID != daemonID {
		t.Fatalf("restart reconnect response=%+v err=%v", response, err)
	}
}

func TestReconnectRegistryRejectsBroadPermissions(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "relay-registry.json")
	if err := os.WriteFile(statePath, []byte(`{"version":1,"reconnect":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(statePath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPersistentHub("kt", statePath); err == nil {
		t.Fatal("loaded relay registry readable by group or other")
	}
}

func TestRegistryWriteSecuresExistingDirectoryAndStateFile(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(parent, "relay-registry.json")
	if _, err := RotateJoinToken(statePath); err != nil {
		t.Fatal(err)
	}
	parentInfo, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	if got := parentInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("registry parent mode=%o want=700", got)
	}
	stateInfo, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := stateInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("registry state mode=%o want=600", got)
	}
}

func TestRotateJoinAndKickApplyOnNextHubLoad(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "relay-registry.json")
	running, err := NewPersistentHub("old-join", statePath)
	if err != nil {
		t.Fatal(err)
	}
	dA, dH := NewPipePair(8)
	daemonID, reconnectToken, _ := registerTestDaemonWithJoin(t, running, dA, dH, "old-join")

	newJoin, err := RotateJoinToken(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if !running.AcceptsJoinToken("old-join") || running.AcceptsJoinToken(newJoin) {
		t.Fatal("offline rotation unexpectedly mutated the running Hub")
	}
	state, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(state, []byte(newJoin)) || bytes.Contains(state, []byte(reconnectToken)) {
		t.Fatal("relay registry contains a raw join or reconnect token")
	}

	restarted, err := NewPersistentHub("old-join", statePath)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.AcceptsJoinToken("old-join") || !restarted.AcceptsJoinToken(newJoin) {
		t.Fatal("persisted join rotation did not take effect on restart")
	}
	badA, badH := NewPipePair(8)
	restarted.HandleDaemon(badH, envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "join_token": "old-join",
	}))
	assertErrorCode(t, badA, "bad_token")

	removed, err := KickDaemon(statePath, daemonID)
	if err != nil || !removed {
		t.Fatalf("KickDaemon removed=%v err=%v", removed, err)
	}
	afterKick, err := NewPersistentHub(newJoin, statePath)
	if err != nil {
		t.Fatal(err)
	}
	reconnectA, reconnectH := NewPipePair(8)
	afterKick.HandleDaemon(reconnectH, envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "daemon_id": daemonID, "reconnect_token": reconnectToken,
	}))
	assertErrorCode(t, reconnectA, "bad_token")
}

func TestKickAndRotateSurviveLiveEnroll(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "relay-registry.json")
	running, err := NewPersistentHub("old-join", statePath)
	if err != nil {
		t.Fatal(err)
	}
	dA, dH := NewPipePair(8)
	daemonID, reconnectToken, _ := registerTestDaemonWithJoin(t, running, dA, dH, "old-join")

	newJoin, err := RotateJoinToken(statePath)
	if err != nil {
		t.Fatal(err)
	}
	removed, err := KickDaemon(statePath, daemonID)
	if err != nil || !removed {
		t.Fatalf("KickDaemon removed=%v err=%v", removed, err)
	}

	d2A, d2H := NewPipePair(8)
	_, _, _ = registerTestDaemonWithJoin(t, running, d2A, d2H, "old-join")

	restarted, err := NewPersistentHub("ignored", statePath)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.AcceptsJoinToken("old-join") || !restarted.AcceptsJoinToken(newJoin) {
		t.Fatal("live enroll overwrote join rotation")
	}
	staleA, staleH := NewPipePair(8)
	restarted.HandleDaemon(staleH, envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "daemon_id": daemonID, "reconnect_token": reconnectToken,
	}))
	assertErrorCode(t, staleA, "bad_token")
}

func TestPingPongRequireEightBytePayload(t *testing.T) {
	h := NewHub("kt")
	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	payload := []byte{0, 0, 0, 0, 0, 0, 0, 7}
	h.HandleClient(cH, envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: payload})
	fr, ok := cA.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypPONG || !bytes.Equal(fr.Payload, payload) {
		t.Fatalf("PONG ok=%v typ=%d payload=%x", ok, fr.Typ, fr.Payload)
	}

	badA, badH := NewPipePair(8)
	h.HandleClient(badH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(badH, envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: []byte{1}})
	assertErrorCode(t, badA, "unbound")

	badPongA, badPongH := NewPipePair(8)
	h.HandleClient(badPongH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(badPongH, envelope.Frame{Version: 1, Typ: envelope.TypPONG, Payload: nil})
	assertErrorCode(t, badPongA, "unbound")
}

func TestPingDoesNotExtendResumeHelloDeadline(t *testing.T) {
	h := NewHub("kt")
	h.resumeWait = 20 * time.Millisecond
	dA, dH := NewPipePair(8)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("session bound ok=%v typ=%d", ok, fr.Typ)
	}
	_, _ = dA.RecvTimeout(time.Second)
	h.HandleClient(cH, envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: make([]byte, 8)})
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypPONG {
		t.Fatalf("PONG ok=%v typ=%d", ok, fr.Typ)
	}
	assertErrorCode(t, cA, "unpaired")
}

func TestHubRejectsInvalidEnvelopeAsBadFrame(t *testing.T) {
	h := NewHub("kt")
	for _, handle := range []func(Conn, envelope.Frame){h.HandleClient, h.HandleDaemon} {
		peer, relay := NewPipePair(8)
		handle(relay, envelope.Frame{Version: 2, Typ: envelope.TypHELLO_CLIENT})
		assertErrorCode(t, peer, "bad_frame")
	}
}

func TestMalformedExternalJSONReturnsError(t *testing.T) {
	h := NewHub("kt")
	cA, cH := NewPipePair(4)
	h.HandleClient(cH, envelope.Frame{Version: 1, Typ: envelope.TypHELLO_CLIENT, Payload: []byte(`{"v":`)})
	assertErrorCode(t, cA, "bad_token")
}

func registerTestDaemon(t *testing.T, h *Hub, daemon, relay *Pipe) (daemonID, reconnectToken string, response envelope.Frame) {
	return registerTestDaemonWithJoin(t, h, daemon, relay, "kt")
}

func registerTestDaemonWithJoin(t *testing.T, h *Hub, daemon, relay *Pipe, join string) (daemonID, reconnectToken string, response envelope.Frame) {
	t.Helper()
	h.HandleDaemon(relay, envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "join_token": join,
	}))
	fr, ok := daemon.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypHELLO_DAEMON {
		t.Fatalf("register daemon: ok=%v typ=%d payload=%s", ok, fr.Typ, fr.Payload)
	}
	var body struct {
		DaemonID       string `json:"daemon_id"`
		ReconnectToken string `json:"reconnect_token"`
	}
	if err := json.Unmarshal(fr.Payload, &body); err != nil || body.DaemonID == "" || body.ReconnectToken == "" {
		t.Fatalf("register response=%+v err=%v", body, err)
	}
	return body.DaemonID, body.ReconnectToken, fr
}

func assertErrorCode(t *testing.T, conn *Pipe, want string) {
	t.Helper()
	fr, ok := conn.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypERROR {
		t.Fatalf("error frame: ok=%v typ=%d payload=%s", ok, fr.Typ, fr.Payload)
	}
	var body envelope.ErrorBody
	if err := json.Unmarshal(fr.Payload, &body); err != nil || body.Code != want {
		t.Fatalf("error body=%+v err=%v want=%s", body, err, want)
	}
}
