package daemon

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/audit"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func decryptPushForTest(t *testing.T, body, userPublic, auth []byte, userPrivate *ecdsa.PrivateKey) []byte {
	t.Helper()
	if len(body) < 86 || body[20] != 65 {
		t.Fatalf("bad aes128gcm body header")
	}
	salt, serverPublic := body[:16], body[21:86]
	sx, sy := elliptic.Unmarshal(elliptic.P256(), serverPublic)
	if sx == nil {
		t.Fatal("bad server ECDH key")
	}
	sharedX, _ := elliptic.P256().ScalarMult(sx, sy, userPrivate.D.FillBytes(make([]byte, 32)))
	shared := sharedX.FillBytes(make([]byte, 32))
	keyInfo := append([]byte("WebPush: info\x00"), userPublic...)
	keyInfo = append(keyInfo, serverPublic...)
	ikm := hkdfExpand(hkdfExtract(auth, shared), keyInfo, 32)
	prk := hkdfExtract(salt, ikm)
	cek := hkdfExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfExpand(prk, []byte("Content-Encoding: nonce\x00"), 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, body[86:], nil)
	if err != nil || len(plain) == 0 || plain[len(plain)-1] != 2 {
		t.Fatalf("decrypt push: %v", err)
	}
	return plain[:len(plain)-1]
}

func TestPushIPClassification(t *testing.T) {
	unsafe := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "ff02::1"}
	for _, raw := range unsafe {
		if !isUnsafePushIP(net.ParseIP(raw)) {
			t.Errorf("unsafe push IP accepted: %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if isUnsafePushIP(net.ParseIP(raw)) {
			t.Errorf("public push IP rejected: %s", raw)
		}
	}
}

func TestPersistentIdentityRPCPushAndRevokeLifecycle(t *testing.T) {
	var serverMu sync.Mutex
	status := http.StatusCreated
	requests := 0
	var lastHeader, lastBody string
	pushServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		serverMu.Lock()
		requests++
		lastHeader = r.Header.Get("Authorization") + "|" + r.Header.Get("Content-Encoding")
		lastBody = string(body)
		code := status
		serverMu.Unlock()
		w.WriteHeader(code)
	}))
	defer pushServer.Close()

	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logger, err := audit.Open(store.AuditPath())
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	hub := mux.NewHub("pf_test")
	engA, hubD := mux.NewPipePair(64)
	eng, err := NewPersistentEngine(hub, engA, runtime.NewFake(), store, logger)
	if err != nil {
		t.Fatal(err)
	}
	transport := pushServer.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // test server only
	serverAddr := pushServer.Listener.Addr().String()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, serverAddr)
	}
	eng.PushHTTPClient = &http.Client{Transport: transport}
	pushEndpoint := "https://push.example.test/send/private-query?token=secret"
	stopD := pump(t, hubD, func(f envelope.Frame) { hub.HandleDaemon(hubD, f) })
	defer close(stopD)
	if err := eng.Register("pf_test"); err != nil {
		t.Fatal(err)
	}
	stopE := make(chan struct{})
	go eng.RecvLoop(stopE)
	defer close(stopE)

	psk := make([]byte, 32)
	_, _ = rand.Read(psk)
	deviceID := "dev_12345678"
	eng.PutDevice(deviceID, psk)
	clientSide, hubClient := mux.NewPipePair(64)
	stopC := pump(t, hubClient, func(f envelope.Frame) { hub.HandleClient(hubClient, f) })
	defer close(stopC)
	ph := &phone.Client{Conn: clientSide, DeviceID: deviceID, PSK: psk, DaemonPK: eng.PK}
	if err := ph.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}

	if _, err := ph.RPC("SendKeys", map[string]any{"pane_id": "w0:p1", "keys": []string{"Enter"}}); err == nil || err.Error() != "invalid_key" {
		t.Fatalf("missing intent was not rejected: %v", err)
	}
	if _, err := ph.RPC("SendText", map[string]any{"pane_id": "w0:p1", "text": "x", "unknown": true}); err == nil || err.Error() != "unknown_op" {
		t.Fatalf("unknown write field was not rejected: %v", err)
	}
	if _, err := ph.RPC("History", map[string]any{"pane_id": "w0:p1", "limit": 20}); err == nil || !strings.Contains(err.Error(), "transcript_unavailable") {
		t.Fatalf("history must fail closed without transcript mapping: %v", err)
	}
	if _, err := ph.RPC("RenameTab", map[string]any{"operation_id": "op_BAECAwQFBgcICQoL", "tab_id": "w0:t1", "label": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ph.RPC("RenamePane", map[string]any{"operation_id": "op_BQECAwQFBgcICQoL", "pane_id": "w0:p1", "label": "renamed-pane"}); err != nil {
		t.Fatalf("RenamePane non-null label: %v", err)
	}

	userKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	userPublic := elliptic.Marshal(elliptic.P256(), userKey.X, userKey.Y)
	authSecret := make([]byte, 16)
	_, _ = rand.Read(authSecret)
	if _, err := ph.RPC("PushSubscribe", map[string]any{
		"operation_id": "op_BgECAwQFBgcICQoL",
		"endpoint":     pushEndpoint,
		"p256dh":       canon.B64URL(userPublic), "auth": canon.B64URL(authSecret),
	}); err != nil {
		t.Fatal(err)
	}
	if err := eng.NotifyHerd(HerdPush{HerdID: "w0:p1", Agent: "claude", WorkspaceLabel: "pairfob", Cwd: "/Users/private/project", Kind: PushNeedsYou}); err != nil {
		t.Fatal(err)
	}
	if err := eng.NotifyHerd(HerdPush{HerdID: "w0:p1", Agent: "claude", WorkspaceLabel: "pairfob", Cwd: "/Users/private/project", Kind: PushNeedsYou}); err != nil {
		t.Fatal(err)
	}
	serverMu.Lock()
	if requests != 1 {
		t.Fatalf("debounce requests=%d want 1", requests)
	}
	if !strings.Contains(lastHeader, "vapid t=") || !strings.Contains(lastHeader, "|aes128gcm") {
		t.Fatalf("missing Web Push headers: %s", lastHeader)
	}
	if strings.Contains(lastBody, "private") || strings.Contains(lastBody, "claude") {
		t.Fatal("push plaintext leaked into encrypted body")
	}
	plain := decryptPushForTest(t, []byte(lastBody), userPublic, authSecret, userKey)
	if strings.Contains(string(plain), "/Users/private") || !strings.Contains(string(plain), `"body":"pairfob · project"`) {
		t.Fatalf("privacy-minimized payload mismatch: %s", plain)
	}
	var notification map[string]string
	if err := json.Unmarshal(plain, &notification); err != nil {
		t.Fatal(err)
	}
	if notification["title"] != "claude 等你处理" || notification["url"] != "/pair#d="+eng.DaemonID+"&notify=1&pane=w0%3Ap1" {
		t.Fatalf("notification target mismatch: %+v", notification)
	}
	needsTag := notification["tag"]
	if !strings.HasPrefix(needsTag, "pairfob-pane-") {
		t.Fatalf("pane notification tag mismatch: %+v", notification)
	}
	serverMu.Unlock()
	if err := eng.NotifyHerd(HerdPush{HerdID: "w0:p1", Agent: "claude", WorkspaceLabel: "pairfob", Cwd: "/Users/private/project", Kind: PushDone}); err != nil {
		t.Fatal(err)
	}
	serverMu.Lock()
	if requests != 2 {
		t.Fatalf("different notification kinds shared a debounce: requests=%d want 2", requests)
	}
	doneBody := lastBody
	serverMu.Unlock()
	donePlain := decryptPushForTest(t, []byte(doneBody), userPublic, authSecret, userKey)
	if err := json.Unmarshal(donePlain, &notification); err != nil {
		t.Fatal(err)
	}
	if notification["title"] != "claude 已完成" || notification["tag"] != needsTag {
		t.Fatalf("completion notification mismatch: %+v", notification)
	}
	serverMu.Lock()
	authorization := strings.Split(lastHeader, "|")[0]
	token := strings.TrimPrefix(strings.Split(authorization, ", k=")[0], "vapid t=")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("invalid VAPID JWT: %s", token)
	}
	headerJSON, _ := base64.RawURLEncoding.DecodeString(parts[0])
	claimsJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if string(headerJSON) != `{"typ":"JWT","alg":"ES256"}` || !strings.Contains(string(claimsJSON), `"aud":"https://push.example.test"`) {
		t.Fatalf("invalid VAPID JWT header/claims: %s %s", headerJSON, claimsJSON)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	publicX, publicY := elliptic.Unmarshal(elliptic.P256(), eng.VAPIDPublicBytes())
	if len(signature) != 64 || !ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: publicX, Y: publicY}, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		t.Fatal("invalid raw ES256 VAPID signature")
	}
	status = http.StatusGone
	serverMu.Unlock()
	payload, _ := json.Marshal(map[string]string{"title": "safe", "body": "safe", "tag": "herd"})
	if err := eng.DeliverPush(deviceID, payload); err != nil {
		t.Fatal(err)
	}
	rows := eng.ListDeviceRows()
	if len(rows) != 1 || len(rows[0].PushSubscriptions) != 0 {
		t.Fatalf("410 did not durably clean subscription: %+v", rows)
	}
	if _, err := ph.RPC("RevokeDevice", map[string]any{"operation_id": "op_BwECAwQFBgcICQoL", "device_id": deviceID, "reason": "test cleanup"}); err != nil {
		t.Fatalf("self revoke reply was not delivered: %v", err)
	}
	remainingSessions := -1
	for i := 0; i < 100; i++ {
		eng.mu.Lock()
		remainingSessions = len(eng.sessions)
		eng.mu.Unlock()
		if remainingSessions == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if eng.HasDevice(deviceID) || remainingSessions != 0 {
		t.Fatal("revoke did not terminate active device")
	}

	pkBefore := append([]byte(nil), eng.PK...)
	eng2A, _ := mux.NewPipePair(16)
	eng2, err := NewPersistentEngine(nil, eng2A, runtime.NewFake(), store, logger)
	if err != nil {
		t.Fatal(err)
	}
	if string(pkBefore) != string(eng2.PK) || eng2.DaemonID != eng.DaemonID {
		t.Fatal("daemon identity was not restored")
	}
	rows = eng2.ListDeviceRows()
	if len(rows) != 1 || rows[0].RevokedAt == nil {
		t.Fatal("device revocation was not restored")
	}
	if info, err := os.Stat(store.AuditPath()); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("audit mode: info=%v err=%v", info, err)
	}
}
