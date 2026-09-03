package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"pairfob/internal/daemon"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func TestEnrollV2PersistsTokensAndOmitsOrigin(t *testing.T) {
	var sawOrigin string
	var sawCookie bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawOrigin = r.Header.Get("Origin")
		if _, ok := r.Header["Cookie"]; ok || r.Header.Get("Cookie") != "" {
			sawCookie = true
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v2/enroll" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		var req struct {
			V              int    `json:"v"`
			JoinGrant      string `json:"join_grant"`
			DaemonID       string `json:"daemon_id"`
			ReconnectToken string `json:"reconnect_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.V != 2 || req.JoinGrant != "" ||
			!daemonIDPattern.MatchString(req.DaemonID) || !reconnectTokenPattern.MatchString(req.ReconnectToken) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": req.DaemonID, "reconnect_token": req.ReconnectToken,
		})
	}))
	defer server.Close()

	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := enrollV2(store, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if sawOrigin != "" {
		t.Fatalf("enroll sent Origin %q", sawOrigin)
	}
	if sawCookie {
		t.Fatal("enroll sent Cookie")
	}
	if relay.Protocol != 2 || !reconnectTokenPattern.MatchString(relay.ReconnectToken) || !strings.Contains(relay.URL, "daemon_id=d_") {
		t.Fatalf("relay=%+v", relay)
	}
	loaded, err := store.LoadRelay()
	if err != nil {
		t.Fatal(err)
	}
	if loaded != relay {
		t.Fatalf("persisted %+v want %+v", loaded, relay)
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if !daemonIDPattern.MatchString(id.DaemonID) || !strings.Contains(relay.URL, "daemon_id="+id.DaemonID) {
		t.Fatalf("daemon_id=%q", id.DaemonID)
	}
}

func TestEnrollV2OldPendingJoinGrantIsNotSent(t *testing.T) {
	var sawGrant bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if _, ok := req["join_grant"]; ok {
			sawGrant = true
			http.Error(w, "unexpected grant", http.StatusBadRequest)
			return
		}
		daemonID, _ := req["daemon_id"].(string)
		token, _ := req["reconnect_token"].(string)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": daemonID, "reconnect_token": token,
		})
	}))
	defer server.Close()
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SavePendingEnroll(state.PendingEnroll{
		Origin: server.URL, JoinGrant: "jg_" + strings.Repeat("ab", 16),
		DaemonID: "d_" + strings.Repeat("11", 10), ReconnectToken: "rt_" + strings.Repeat("22", 16), CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := enrollV2(store, server.URL); err != nil {
		t.Fatal(err)
	}
	if sawGrant {
		t.Fatal("old pending join_grant was sent")
	}
}

func TestEnrollV2GrantlessOmitsJoinGrant(t *testing.T) {
	var sawGrant bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if _, ok := req["join_grant"]; ok {
			sawGrant = true
			http.Error(w, "unexpected grant", http.StatusBadRequest)
			return
		}
		daemonID, _ := req["daemon_id"].(string)
		token, _ := req["reconnect_token"].(string)
		if !daemonIDPattern.MatchString(daemonID) || !reconnectTokenPattern.MatchString(token) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": daemonID, "reconnect_token": token,
		})
	}))
	defer server.Close()
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := enrollV2(store, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if sawGrant {
		t.Fatal("grantless enroll sent join_grant")
	}
	if relay.Protocol != 2 || !reconnectTokenPattern.MatchString(relay.ReconnectToken) {
		t.Fatalf("relay=%+v", relay)
	}
}

func TestEnrollV2JoinTokenRejectedByInference(t *testing.T) {
	_, err := inferMux(muxEnv{
		RelayWS:   "wss://pairfob.com/v2/ws?role=daemon",
		JoinGrant: "jg_" + strings.Repeat("a", 32),
		JoinToken: "pf_dev",
		Origin:    "https://pairfob.com",
	})
	if err == nil || !strings.Contains(err.Error(), "JOIN_TOKEN") {
		t.Fatalf("got %v", err)
	}
}

func TestLiveAdminRekeyUpdatesRunningEngine(t *testing.T) {
	const daemonID = "d_abcdef0123456789abcd"
	oldToken := "rt_" + strings.Repeat("33", 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		decodeErr := json.NewDecoder(r.Body).Decode(&req)
		nextToken, ok := req["new_reconnect_token"].(string)
		if decodeErr != nil || req["reconnect_token"] != oldToken || !ok || !reconnectTokenPattern.MatchString(nextToken) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "reconnect_token": nextToken})
	}))
	defer server.Close()

	store := configuredV2Store(t, daemonID, oldToken, server.URL)
	conn, _ := mux.NewPipePair(4)
	eng := daemon.NewEngine(nil, conn, runtime.NewFake())
	eng.DaemonID, eng.Reconnect, eng.MuxProtocol = daemonID, oldToken, 2
	result, err := (liveAdmin{eng: eng, store: store, origin: server.URL}).Rekey()
	if err != nil {
		t.Fatal(err)
	}
	if result.Protocol != 2 || result.URL == "" || eng.Reconnect == oldToken || !reconnectTokenPattern.MatchString(eng.Reconnect) {
		t.Fatalf("result=%+v active=%q", result, eng.Reconnect)
	}
	stored, err := store.LoadRelay()
	if err != nil || stored.ReconnectToken != eng.Reconnect {
		t.Fatalf("stored=%+v err=%v", stored, err)
	}
}

func TestEnrollV2RetriesTheSamePendingCredentialAfterResponseLoss(t *testing.T) {
	var calls atomic.Int32
	var firstMu sync.Mutex
	var firstDaemonID, firstToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			JoinGrant      string `json:"join_grant"`
			DaemonID       string `json:"daemon_id"`
			ReconnectToken string `json:"reconnect_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.JoinGrant != "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if calls.Add(1) == 1 {
			firstMu.Lock()
			firstDaemonID, firstToken = req.DaemonID, req.ReconnectToken
			firstMu.Unlock()
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		firstMu.Lock()
		wantID, wantToken := firstDaemonID, firstToken
		firstMu.Unlock()
		if req.DaemonID != wantID || req.ReconnectToken != wantToken {
			http.Error(w, "credential changed", http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": req.DaemonID, "reconnect_token": req.ReconnectToken,
		})
	}))
	defer server.Close()
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := enrollV2(store, server.URL); err == nil {
		t.Fatal("lost enroll response reported success")
	}
	firstMu.Lock()
	wantID, wantToken := firstDaemonID, firstToken
	firstMu.Unlock()
	if pending, ok, err := store.LoadPendingEnroll(); err != nil || !ok || pending.DaemonID != wantID {
		t.Fatalf("pending=%+v ok=%t err=%v", pending, ok, err)
	}
	relay, err := enrollV2(store, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if relay.ReconnectToken != wantToken || calls.Load() != 2 {
		t.Fatalf("relay=%+v calls=%d", relay, calls.Load())
	}
	if _, ok, err := store.LoadPendingEnroll(); err != nil || ok {
		t.Fatalf("pending enroll not cleared ok=%t err=%v", ok, err)
	}
}

func TestRekeyV2ResumesTheSameReplacementAfterResponseLoss(t *testing.T) {
	const daemonID = "d_abcdef0123456789abcd"
	oldToken := "rt_" + strings.Repeat("33", 16)
	var calls atomic.Int32
	var firstMu sync.Mutex
	var firstNext string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Old  string `json:"reconnect_token"`
			Next string `json:"new_reconnect_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Old != oldToken || !reconnectTokenPattern.MatchString(req.Next) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if calls.Add(1) == 1 {
			firstMu.Lock()
			firstNext = req.Next
			firstMu.Unlock()
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		firstMu.Lock()
		wantNext := firstNext
		firstMu.Unlock()
		if req.Next != wantNext {
			http.Error(w, "replacement changed", http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "reconnect_token": req.Next})
	}))
	defer server.Close()
	store := configuredV2Store(t, daemonID, oldToken, server.URL)
	if _, err := rekeyV2(store, server.URL); err == nil {
		t.Fatal("lost rekey response reported success")
	}
	firstMu.Lock()
	wantNext := firstNext
	firstMu.Unlock()
	if pending, ok, err := store.LoadPendingRekey(); err != nil || !ok || pending.NextToken != wantNext {
		t.Fatalf("pending=%+v ok=%t err=%v", pending, ok, err)
	}
	relay, resumed, err := resumeRekeyV2(store, server.URL)
	if err != nil || !resumed {
		t.Fatalf("relay=%+v resumed=%t err=%v", relay, resumed, err)
	}
	if relay.ReconnectToken != wantNext || calls.Load() != 2 {
		t.Fatalf("relay=%+v calls=%d", relay, calls.Load())
	}
	if _, ok, err := store.LoadPendingRekey(); err != nil || ok {
		t.Fatalf("pending rekey not cleared ok=%t err=%v", ok, err)
	}
}

func TestReconcilePendingEnrollClearsOnlyACompleteLocalCommit(t *testing.T) {
	const daemonID = "d_abcdef0123456789abcd"
	token := "rt_" + strings.Repeat("33", 16)
	store := configuredV2Store(t, daemonID, token, "https://pairfob.com")
	if err := store.SavePendingEnroll(state.PendingEnroll{
		Origin: "https://pairfob.com", JoinGrant: "jg_" + strings.Repeat("12", 16),
		DaemonID: daemonID, ReconnectToken: token, CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	relay, err := store.LoadRelay()
	if err != nil {
		t.Fatal(err)
	}
	if err := reconcilePendingEnroll(store, relay); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.LoadPendingEnroll(); err != nil || ok {
		t.Fatalf("pending enroll not reconciled ok=%t err=%v", ok, err)
	}
}

func configuredV2Store(t *testing.T, daemonID, reconnect, origin string) *state.Store {
	t.Helper()
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	id.DaemonID = daemonID
	if err := store.SaveIdentity(id); err != nil {
		t.Fatal(err)
	}
	wsURL, err := daemonRelayURL(origin, daemonID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveRelay(state.Relay{URL: wsURL, ReconnectToken: reconnect, Protocol: 2}); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestEnrollCommandWritesRelayAgainstOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			JoinGrant      string `json:"join_grant"`
			DaemonID       string `json:"daemon_id"`
			ReconnectToken string `json:"reconnect_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.JoinGrant != "" {
			http.Error(w, "bad", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": req.DaemonID, "reconnect_token": req.ReconnectToken,
		})
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_JOIN_GRANT", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	sock := filepath.Join(dir, "not-running.sock")
	if err := enrollCommand([]string{"--origin", server.URL}, sock); err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	relay, err := store.LoadRelay()
	if err != nil || relay.Protocol != 2 || relay.ReconnectToken == "" {
		t.Fatalf("relay=%+v err=%v", relay, err)
	}
}

func TestEnrollCommandRefusesWhileDaemonRuns(t *testing.T) {
	a, _ := mux.NewPipePair(4)
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	sock := startLiveAdmin(t, eng)
	err := enrollCommand(nil, sock)
	if err == nil || !strings.Contains(err.Error(), "running") {
		t.Fatalf("got %v", err)
	}
}

func TestEnrollCommandWithoutGrantHitsOrigin(t *testing.T) {
	var sawGrant bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			JoinGrant      string `json:"join_grant"`
			DaemonID       string `json:"daemon_id"`
			ReconnectToken string `json:"reconnect_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.JoinGrant != "" ||
			!daemonIDPattern.MatchString(req.DaemonID) || !reconnectTokenPattern.MatchString(req.ReconnectToken) {
			http.Error(w, "bad", 400)
			return
		}
		if _, ok := r.URL.Query()["join_grant"]; ok {
			sawGrant = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "daemon_id": req.DaemonID, "reconnect_token": req.ReconnectToken,
		})
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("PAIRFOB_JOIN_GRANT", "")
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	if err := enrollCommand([]string{"--origin", server.URL}, filepath.Join(dir, "not-running.sock")); err != nil {
		t.Fatal(err)
	}
	if sawGrant {
		t.Fatal("grantless enroll put join_grant on the URL")
	}
	store, err := state.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	relay, err := store.LoadRelay()
	if err != nil || relay.Protocol != 2 || relay.ReconnectToken == "" {
		t.Fatalf("relay=%+v err=%v", relay, err)
	}
}

func TestVersionLineIncludesDevBuild(t *testing.T) {
	line := versionLine()
	if !strings.Contains(line, "pairfob") || !strings.Contains(line, version) {
		t.Fatalf("%q", line)
	}
}

func TestEnrollV2OriginRejectsAreHumanNextSteps(t *testing.T) {
	cases := []struct {
		code   string
		status int
		want   string
	}{
		{code: "rate_limited", status: 429, want: "too many computers"},
		{code: "unexpected_wire", status: 400, want: "pairfob doctor"},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ok": false, "error": map[string]string{"code": tc.code},
				})
			}))
			t.Cleanup(server.Close)
			store, err := state.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			_, err = enrollV2(store, server.URL)
			if err == nil {
				t.Fatal("expected rejection")
			}
			got := err.Error()
			if !strings.Contains(got, tc.want) {
				t.Fatalf("got %q want substring %q", got, tc.want)
			}
			assertOperatorText(t, got)
			if strings.Contains(got, "enroll rejected") || strings.Contains(got, tc.code) {
				t.Fatalf("leaked wire material: %q", got)
			}
		})
	}
}

func TestEnrollV2UnreachableOriginIsHuman(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = enrollV2(store, server.URL)
	if err == nil || !strings.Contains(err.Error(), "pairfob doctor") {
		t.Fatalf("got %v", err)
	}
	assertOperatorText(t, err.Error())
}

func TestEnrollCommandRejectsJoinGrant(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_JOIN_GRANT", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	sock := filepath.Join(dir, "not-running.sock")
	err := enrollCommand([]string{"--grant", "jg_" + strings.Repeat("11", 16)}, sock)
	if err == nil || !strings.Contains(err.Error(), "join grant") {
		t.Fatalf("got %v", err)
	}
	assertOperatorText(t, err.Error())
	t.Setenv("PAIRFOB_JOIN_GRANT", "jg_"+strings.Repeat("22", 16))
	err = enrollCommand([]string{"--origin", "https://pairfob.com"}, sock)
	if err == nil || !strings.Contains(err.Error(), "join grant") {
		t.Fatalf("got %v", err)
	}
	assertOperatorText(t, err.Error())
}

func TestEnrollCommandAlreadySetUpWithoutGrantIsNoop(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("PAIRFOB_JOIN_GRANT", "")
	t.Setenv("PAIRFOB_JOIN_TOKEN", "")
	t.Setenv("PAIRFOB_ORIGIN", "")
	store, err := state.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := state.Relay{
		URL:            "wss://pairfob.com/v2/ws?role=daemon&daemon_id=d_0123456789abcdef0123",
		ReconnectToken: "rt_" + strings.Repeat("22", 16), Protocol: 2,
	}
	if err := store.SaveRelay(want); err != nil {
		t.Fatal(err)
	}
	if err := enrollCommand(nil, filepath.Join(dir, "not-running.sock")); err != nil {
		t.Fatal(err)
	}
	got, err := store.LoadRelay()
	if err != nil || got != want {
		t.Fatalf("relay=%+v err=%v", got, err)
	}
}
