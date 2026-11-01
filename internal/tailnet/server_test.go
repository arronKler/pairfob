package tailnet

import (
	"crypto/rand"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/runtime"
)

func TestGatewayServesShellAndUpgradesWebSocket(t *testing.T) {
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	gateway := New(listener, origin)
	engine := daemon.NewEngine(nil, gateway, runtime.NewFake())
	engine.DaemonID = "d_0123456789abcdef0123"
	gateway.Attach(engine)
	go func() { _ = gateway.Serve() }()
	t.Cleanup(gateway.Close)

	response, err := http.Get(origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d", response.StatusCode)
	}

	endpoint, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.Scheme = "ws"
	endpoint.Path = "/v2/ws"
	query := endpoint.Query()
	query.Set("role", "client")
	query.Set("daemon_id", engine.DaemonID)
	endpoint.RawQuery = query.Encode()
	dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
	connection, response, err := dialer.Dial(endpoint.String(), http.Header{"Origin": []string{origin}})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("websocket upgrade status=%d: %v", status, err)
	}
	defer connection.Close()
	if connection.Subprotocol() != subprotocol {
		t.Fatalf("subprotocol = %q", connection.Subprotocol())
	}
	frame := envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 2, "protocol": 2})
	encoded, err := envelope.EncodeChecked(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteMessage(websocket.BinaryMessage, encoded); err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteMessage(websocket.BinaryMessage, make([]byte, maxWSMessage+1)); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := connection.ReadMessage(); err == nil {
		t.Fatal("oversized unpaired WebSocket message remained connected")
	}
}

func TestGatewayCachesOnlyFingerprintedStaticAssets(t *testing.T) {
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	gateway := New(listener, origin)
	go func() { _ = gateway.Serve() }()
	t.Cleanup(gateway.Close)

	assets, err := fs.ReadDir(uiFiles, "ui/generated/assets")
	if err != nil || len(assets) == 0 {
		t.Fatalf("embedded assets: %v", err)
	}
	assetPath := "/assets/" + assets[0].Name()
	for _, request := range []struct{ path, cache string }{
		{"/", "no-store"},
		{"/api/config", "no-store"},
		{assetPath, "public, max-age=31536000, immutable"},
	} {
		response, err := http.Get(origin + request.path)
		if err != nil {
			t.Fatal(err)
		}
		if got := response.Header.Get("Cache-Control"); got != request.cache {
			response.Body.Close()
			t.Fatalf("%s cache = %q, want %q", request.path, got, request.cache)
		}
		response.Body.Close()
	}
}

func TestListenerRejectsNonTailnetInterfaces(t *testing.T) {
	for _, address := range []string{"0.0.0.0:18474", "192.168.1.2:18474", "http://0.0.0.0:18474"} {
		if listener, err := Listen(address); err == nil {
			_ = listener.Close()
			t.Fatalf("accepted unsafe listener %q", address)
		}
	}
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := ValidateOrigin("http://192.168.1.2:18474", listener); err == nil {
		t.Fatal("accepted LAN pairing origin")
	}
}

func TestCrossComputerOriginRequiresTailnetIPAndPort(t *testing.T) {
	const own = "http://100.64.1.3:18474"
	for _, origin := range []string{"http://192.168.1.2:18474", "http://100.64.1.2:8474", "http://100.64.1.2:18474/path", "https://100.64.1.2:18474"} {
		if sameTailnetOrigin(origin, own) {
			t.Fatalf("accepted cross-computer origin %q", origin)
		}
	}
	if !sameTailnetOrigin("http://100.64.1.2:18474", own) {
		t.Fatal("rejected another direct tailnet origin")
	}
}

func TestGatewayEstablishesEncryptedSessionAndForwardsPing(t *testing.T) {
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	gateway := New(listener, origin)
	engine := daemon.NewEngine(nil, gateway, runtime.NewFake())
	engine.DaemonID = "d_0123456789abcdef0123"
	engine.MuxProtocol = 2
	engine.DirectMux = true
	deviceID := "dev_0123456789abcdef"
	psk := make([]byte, 32)
	if _, err := rand.Read(psk); err != nil {
		t.Fatal(err)
	}
	engine.PutDevice(deviceID, psk)
	gateway.Attach(engine)
	go func() { _ = gateway.Serve() }()
	t.Cleanup(gateway.Close)

	endpoint, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.Scheme, endpoint.Path = "ws", "/v2/ws"
	query := endpoint.Query()
	query.Set("role", "client")
	query.Set("daemon_id", engine.DaemonID)
	endpoint.RawQuery = query.Encode()
	connection, response, err := (&websocket.Dialer{Subprotocols: []string{subprotocol}}).Dial(endpoint.String(), http.Header{"Origin": []string{origin}})
	if err != nil {
		if response != nil {
			t.Fatalf("websocket upgrade status=%d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer connection.Close()
	write := func(frame envelope.Frame) {
		data, err := envelope.EncodeChecked(frame)
		if err != nil {
			t.Fatal(err)
		}
		if err := connection.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func() envelope.Frame {
		t.Helper()
		if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		kind, data, err := connection.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind != websocket.BinaryMessage {
			t.Fatalf("message kind=%d", kind)
		}
		frame, err := envelope.Decode(data)
		if err != nil {
			t.Fatal(err)
		}
		return frame
	}

	write(envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 2, "protocol": 2}))
	write(envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 2, "daemon_id": engine.DaemonID}))
	bound := read()
	if bound.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("expected SESSION_BOUND, got %d", bound.Typ)
	}

	var phoneSK, phonePK [32]byte
	if _, err := rand.Read(phoneSK[:]); err != nil {
		t.Fatal(err)
	}
	curve25519.ScalarBaseMult(&phonePK, &phoneSK)
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	hello1, err := json.Marshal(sessionkeys.Hello1{
		V: 1, Op: "DeviceHello1", DeviceID: deviceID, DaemonID: engine.DaemonID,
		EphX25519: canon.B64URL(phonePK[:]), Nonce: canon.B64URL(nonce),
	})
	if err != nil {
		t.Fatal(err)
	}
	write(envelope.Frame{Version: envelope.Version, Typ: envelope.TypFWD, RouteID: bound.RouteID, Payload: hello1})
	hello2Frame := read()
	if hello2Frame.Typ != envelope.TypFWD || hello2Frame.RouteID != bound.RouteID {
		t.Fatalf("expected DeviceHello2 FWD, got type=%d", hello2Frame.Typ)
	}
	var hello2 sessionkeys.Hello2
	if err := json.Unmarshal(hello2Frame.Payload, &hello2); err != nil || !hello2.OK || hello2.Op != "DeviceHello2" {
		t.Fatalf("DeviceHello2=%s err=%v", hello2Frame.Payload, err)
	}
	ephD, err := canon.DecodeB64URL(hello2.EphX25519)
	if err != nil || len(ephD) != 32 {
		t.Fatalf("daemon ephemeral key err=%v", err)
	}
	transcript := sessionkeys.TranscriptD(engine.DaemonID, deviceID, phonePK[:], ephD, nonce, hello2.TS, bound.RouteID)
	hello3, err := json.Marshal(sessionkeys.Hello3{V: 1, Op: "DeviceHello3", ProofP: canon.B64URL(sessionkeys.Proof(psk, sessionkeys.TranscriptP(transcript)))})
	if err != nil {
		t.Fatal(err)
	}
	write(envelope.Frame{Version: envelope.Version, Typ: envelope.TypFWD, RouteID: bound.RouteID, Payload: hello3})
	established := read()
	if established.Typ != envelope.TypSESSION_ESTABLISHED || established.RouteID != bound.RouteID {
		t.Fatalf("expected SESSION_ESTABLISHED, got type=%d", established.Typ)
	}

	dh, err := curve25519.X25519(phoneSK[:], ephD)
	if err != nil {
		t.Fatal(err)
	}
	c2s, s2c := sessionkeys.SessionKeys(dh, psk)
	clientToServer := &aead.Direction{Key: c2s, Dir: aead.DirClient}
	serverToClient := &aead.Direction{Key: s2c, Dir: aead.DirServer}
	ping, err := json.Marshal(map[string]any{"v": 1, "id": "req_ping", "op": "Ping", "params": map[string]any{"t_ms": 7}})
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := aead.Seal(clientToServer, bound.RouteID, ping)
	if err != nil {
		t.Fatal(err)
	}
	write(envelope.Frame{Version: envelope.Version, Typ: envelope.TypFWD, RouteID: bound.RouteID, Payload: ciphertext})
	result := read()
	if result.Typ != envelope.TypFWD || result.RouteID != bound.RouteID {
		t.Fatalf("expected encrypted Ping response, got type=%d", result.Typ)
	}
	plaintext, err := aead.Open(serverToClient, bound.RouteID, result.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var responseBody struct {
		ID     string `json:"id"`
		OK     bool   `json:"ok"`
		Result struct {
			Echo int `json:"t_echo_ms"`
		} `json:"result"`
	}
	if err := json.Unmarshal(plaintext, &responseBody); err != nil {
		t.Fatal(err)
	}
	if responseBody.ID != "req_ping" || !responseBody.OK || responseBody.Result.Echo != 7 {
		t.Fatalf("Ping response=%s", plaintext)
	}
}

func TestGatewayPolicyAllowsBlobImages(t *testing.T) {
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	gateway := New(listener, origin)
	go func() { _ = gateway.Serve() }()
	t.Cleanup(gateway.Close)

	response, err := http.Get(origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	policy := response.Header.Get("Content-Security-Policy")
	if !strings.Contains(policy, "img-src 'self' data: blob:") {
		t.Fatalf("policy = %q, want img-src 'self' data: blob:", policy)
	}
}
