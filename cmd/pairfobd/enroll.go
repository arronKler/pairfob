package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/state"
	"pairfob/internal/wsnet"
)

var (
	joinGrantPattern      = regexp.MustCompile(`^jg_[0-9a-f]{32}$`)
	daemonIDPattern       = regexp.MustCompile(`^d_[0-9a-f]{20}$`)
	reconnectTokenPattern = regexp.MustCompile(`^rt_[0-9a-f]{32}$`)
)

func originHTTPClient(timeout time.Duration) *http.Client {
	client := &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("refusing HTTP redirect")
		},
	}
	tlsCfg, err := wsnet.ClientTLSConfig()
	if err != nil {
		client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, err })
		return client
	}
	if tlsCfg != nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = tlsCfg
		client.Transport = tr
	}
	return client
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func enrollCommand(args []string, sock string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	grant := fs.String("grant", "", "")
	origin := fs.String("origin", "", "")
	force := fs.Bool("force", false, "")
	if err := fs.Parse(args); err != nil {
		return errors.New("usage: pairfobd enroll [--grant jg_…] [--origin URL] [--force]")
	}
	if strings.TrimSpace(os.Getenv("PAIRFOB_JOIN_TOKEN")) != "" {
		return errors.New("this setup does not use a join token")
	}
	if *grant == "" {
		*grant = strings.TrimSpace(os.Getenv("PAIRFOB_JOIN_GRANT"))
	}
	if *grant != "" && !joinGrantPattern.MatchString(*grant) {
		return errors.New("that --grant value isn't valid")
	}
	if *origin == "" {
		*origin = strings.TrimRight(strings.TrimSpace(os.Getenv("PAIRFOB_ORIGIN")), "/")
	}
	if _, err := admin.Call(sock, admin.Request{Op: "pair.status"}); err == nil {
		return errors.New("Pairfob is running. Stop it first, then run this again.")
	} else if !errors.Is(err, admin.ErrNotRunning) {
		return err
	}
	store, err := state.Open("")
	if err != nil {
		return err
	}
	if *origin == "" {
		if pending, ok, pendingErr := store.LoadPendingEnroll(); pendingErr != nil {
			return pendingErr
		} else if ok {
			*origin = pending.Origin
		} else {
			*origin = defaultHostedOrigin
		}
	}
	existing, err := store.LoadRelay()
	if err != nil {
		return err
	}
	if existing.ReconnectToken != "" && !*force {
		if *grant == "" {
			fmt.Printf("This computer is already set up.\nPair a device after Pairfob is running: pairfobd pair\n")
			return nil
		}
		return alreadyEnrolledError()
	}
	if _, err := enrollV2(store, *origin, *grant); err != nil {
		return err
	}
	fmt.Printf("This computer is ready on %s.\nPair a device after Pairfob is running: pairfobd pair\n", originHost(*origin))
	return nil
}

func enrollV2(store *state.Store, origin, joinGrant string) (state.Relay, error) {
	if store == nil {
		return state.Relay{}, errors.New("state store required")
	}
	var err error
	origin, err = canonicalHTTPOrigin(origin)
	if err != nil {
		return state.Relay{}, fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
	}
	pending, exists, err := store.LoadPendingEnroll()
	if err != nil {
		return state.Relay{}, err
	}
	if exists && pending.Origin != origin {
		return state.Relay{}, errors.New("this computer already started setup for a different site. Re-run the installer.")
	}
	if !exists {
		if joinGrant != "" && !joinGrantPattern.MatchString(joinGrant) {
			return state.Relay{}, errors.New("that --grant value isn't valid")
		}
		daemonID, err := randomHostedValue("d_", 10)
		if err != nil {
			return state.Relay{}, err
		}
		reconnectToken, err := randomHostedValue("rt_", 16)
		if err != nil {
			return state.Relay{}, err
		}
		pending = state.PendingEnroll{
			Origin: origin, JoinGrant: joinGrant, DaemonID: daemonID,
			ReconnectToken: reconnectToken, CreatedAt: time.Now().Unix(),
		}
		if err := store.SavePendingEnroll(pending); err != nil {
			return state.Relay{}, err
		}
	} else {
		if joinGrant != "" && joinGrant != pending.JoinGrant {
			return state.Relay{}, errors.New("this computer already started setup. Re-run the installer.")
		}
		joinGrant = pending.JoinGrant
	}
	var body struct {
		OK             bool   `json:"ok"`
		DaemonID       string `json:"daemon_id"`
		ReconnectToken string `json:"reconnect_token"`
		Error          *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	payload := map[string]any{
		"v": 2, "daemon_id": pending.DaemonID, "reconnect_token": pending.ReconnectToken,
	}
	if joinGrant != "" {
		payload["join_grant"] = joinGrant
	}
	if err := postOriginJSON(origin+"/v2/enroll", payload, 15*time.Second, &body); err != nil {
		return state.Relay{}, publicOriginError(err)
	}
	if !body.OK || body.DaemonID != pending.DaemonID || body.ReconnectToken != pending.ReconnectToken {
		code := "enroll_failed"
		if body.Error != nil && body.Error.Code != "" {
			code = body.Error.Code
		}
		return state.Relay{}, enrollRejected(code)
	}
	wsURL, err := daemonRelayURL(origin, body.DaemonID)
	if err != nil {
		return state.Relay{}, err
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		return state.Relay{}, err
	}
	id.DaemonID = body.DaemonID
	if err := store.SaveIdentity(id); err != nil {
		return state.Relay{}, err
	}
	relay := state.Relay{URL: wsURL, ReconnectToken: body.ReconnectToken, Protocol: 2}
	if err := store.SaveRelay(relay); err != nil {
		return state.Relay{}, err
	}
	if err := store.ClearPendingEnroll(); err != nil {
		return state.Relay{}, err
	}
	return relay, nil
}

// reconcilePendingEnroll clears the journal only when every durable local
// artifact already contains the acknowledged credential. Otherwise startup
// leaves it in place and inferMux resumes the same enrollment.
func reconcilePendingEnroll(store *state.Store, relay state.Relay) error {
	pending, exists, err := store.LoadPendingEnroll()
	if err != nil || !exists {
		return err
	}
	if relay.Protocol != 2 || relay.ReconnectToken != pending.ReconnectToken {
		return nil
	}
	u, err := url.Parse(relay.URL)
	if err != nil || u.Query().Get("daemon_id") != pending.DaemonID || originFromWSURL(relay.URL) != pending.Origin {
		return errors.New("pending enroll conflicts with relay.json")
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		return err
	}
	if id.DaemonID != pending.DaemonID {
		return errors.New("pending enroll conflicts with daemon.json")
	}
	return store.ClearPendingEnroll()
}

// POST /v2/rekey carries a client-minted replacement so retrying an uncertain
// response is idempotent. The pending journal is cleared only after relay.json
// contains the acknowledged replacement.
func rekeyV2(store *state.Store, origin string) (state.Relay, error) {
	if store == nil {
		return state.Relay{}, errors.New("state store required")
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		return state.Relay{}, err
	}
	relay, err := store.LoadRelay()
	if err != nil {
		return state.Relay{}, err
	}
	if relay.Protocol != 2 || relay.ReconnectToken == "" || id.DaemonID == "" {
		return state.Relay{}, errors.New("relay rekey requires an enrolled pairfob.v2 daemon")
	}
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		origin = originFromWSURL(relay.URL)
	}
	origin, err = canonicalHTTPOrigin(origin)
	if err != nil {
		return state.Relay{}, fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
	}
	pending, exists, err := store.LoadPendingRekey()
	if err != nil {
		return state.Relay{}, err
	}
	if !exists {
		next, err := randomHostedValue("rt_", 16)
		if err != nil {
			return state.Relay{}, err
		}
		pending = state.PendingRekey{
			Origin: origin, DaemonID: id.DaemonID, PreviousToken: relay.ReconnectToken,
			NextToken: next, CreatedAt: time.Now().Unix(),
		}
		if err := store.SavePendingRekey(pending); err != nil {
			return state.Relay{}, err
		}
	}
	return finishPendingRekey(store, relay, id.DaemonID, origin, pending)
}

func resumeRekeyV2(store *state.Store, origin string) (state.Relay, bool, error) {
	pending, exists, err := store.LoadPendingRekey()
	if err != nil || !exists {
		return state.Relay{}, false, err
	}
	id, _, _, err := store.LoadOrCreateIdentity()
	if err != nil {
		return state.Relay{}, true, err
	}
	relay, err := store.LoadRelay()
	if err != nil {
		return state.Relay{}, true, err
	}
	if origin == "" {
		origin = originFromWSURL(relay.URL)
	}
	origin, err = canonicalHTTPOrigin(origin)
	if err != nil {
		return state.Relay{}, true, fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
	}
	relay, err = finishPendingRekey(store, relay, id.DaemonID, origin, pending)
	return relay, true, err
}

func finishPendingRekey(store *state.Store, relay state.Relay, daemonID, origin string, pending state.PendingRekey) (state.Relay, error) {
	if pending.Origin != origin || pending.DaemonID != daemonID {
		return state.Relay{}, errors.New("pending rekey conflicts with active daemon or origin")
	}
	if relay.ReconnectToken == pending.NextToken {
		if err := store.ClearPendingRekey(); err != nil {
			return state.Relay{}, err
		}
		return relay, nil
	}
	if relay.ReconnectToken != pending.PreviousToken {
		return state.Relay{}, errors.New("pending rekey previous token does not match relay.json")
	}
	var body struct {
		OK             bool   `json:"ok"`
		ReconnectToken string `json:"reconnect_token"`
		Error          *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := postOriginJSON(origin+"/v2/rekey", map[string]any{
		"v": 2, "daemon_id": daemonID, "reconnect_token": pending.PreviousToken,
		"new_reconnect_token": pending.NextToken,
	}, 15*time.Second, &body); err != nil {
		return state.Relay{}, publicOriginError(err)
	}
	if !body.OK || body.ReconnectToken != pending.NextToken {
		code := "rekey_failed"
		if body.Error != nil && body.Error.Code != "" {
			code = body.Error.Code
		}
		return state.Relay{}, rekeyRejected(code)
	}
	relay.ReconnectToken = pending.NextToken
	relay.Protocol = 2
	if err := store.SaveRelay(relay); err != nil {
		return state.Relay{}, err
	}
	if err := store.ClearPendingRekey(); err != nil {
		return state.Relay{}, err
	}
	return relay, nil
}

func randomHostedValue(prefix string, bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buf), nil
}

func postOriginJSON(rawURL string, payload any, timeout time.Duration, dest any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Del("Origin")
	resp, err := originHTTPClient(timeout).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return err
	}
	var decodeErr error
	if dest != nil {
		decodeErr = json.Unmarshal(b, dest)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if dest != nil && decodeErr == nil {
			return nil
		}
		return fmt.Errorf("origin HTTP %d", resp.StatusCode)
	}
	if dest != nil && decodeErr != nil {
		return fmt.Errorf("decode origin response: %w", decodeErr)
	}
	return nil
}

func daemonRelayURL(origin, daemonID string) (string, error) {
	canonical, err := canonicalHTTPOrigin(origin)
	if err != nil {
		return "", fmt.Errorf("PAIRFOB_ORIGIN: %w", err)
	}
	base, _ := url.Parse(canonical)
	scheme := "wss"
	if base.Scheme == "http" {
		scheme = "ws"
	}
	return scheme + "://" + base.Host + "/v2/ws?role=daemon&daemon_id=" + url.QueryEscape(daemonID), nil
}

func probeOriginProtocol(origin string) (int, string) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return 0, ""
	}
	req, err := http.NewRequest(http.MethodGet, origin+"/api/config", nil)
	if err != nil {
		return 0, err.Error()
	}
	req.Header.Del("Origin")
	resp, err := originHTTPClient(2 * time.Second).Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return 0, err.Error()
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	var body struct {
		Protocol int `json:"protocol"`
	}
	if err := json.Unmarshal(b, &body); err != nil {
		return 0, err.Error()
	}
	if body.Protocol != 2 {
		return 0, "origin /api/config protocol must be 2"
	}
	return body.Protocol, ""
}
