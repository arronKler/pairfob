package daemon

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/envelope"
	"pairfob/internal/state"
)

const pushDebounce = 30 * time.Second

func isUnsafePushIP(ip net.IP) bool {
	return ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || !ip.IsGlobalUnicast()
}

// productionPushHTTPClient resolves the endpoint itself and dials a validated
// public address. This check is repeated for every delivery, so a hostname
// cannot use DNS rebinding to reach loopback or a private network. Proxies are
// disabled because they would resolve the target outside this validation.
func productionPushHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("invalid push address: %w", err)
		}
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(resolved) == 0 {
			if err == nil {
				err = errors.New("push endpoint resolved no addresses")
			}
			return nil, err
		}
		for _, candidate := range resolved {
			if isUnsafePushIP(candidate.IP) {
				return nil, fmt.Errorf("push endpoint resolved to non-public address %s", candidate.IP)
			}
		}
		var lastErr error
		for _, candidate := range resolved {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
	return &http.Client{Transport: transport, Timeout: 15 * time.Second}
}

type HerdPush struct {
	HerdID         string
	Agent          string
	WorkspaceLabel string
	Cwd            string
	PaneLabel      string
	TerminalTitle  string
	TabLabel       string
	Kind           PushKind
}

type PushKind string

const (
	PushNeedsYou PushKind = "needs_you"
	PushDone     PushKind = "done"
)

func pushKindForTransition(previous string, known bool, current string) (PushKind, bool) {
	if !known || previous == current {
		return "", false
	}
	if current == "blocked" {
		return PushNeedsYou, true
	}
	if previous == "working" && current == "done" {
		return PushDone, true
	}
	return "", false
}

func hkdfExtract(salt, ikm []byte) []byte {
	mac := hmac.New(sha256.New, salt)
	_, _ = mac.Write(ikm)
	return mac.Sum(nil)
}

func hkdfExpand(prk, info []byte, length int) []byte {
	out := make([]byte, 0, length)
	var previous []byte
	for counter := byte(1); len(out) < length; counter++ {
		mac := hmac.New(sha256.New, prk)
		_, _ = mac.Write(previous)
		_, _ = mac.Write(info)
		_, _ = mac.Write([]byte{counter})
		previous = mac.Sum(nil)
		out = append(out, previous...)
	}
	return out[:length]
}

func encryptWebPush(payload, userPublic, authSecret []byte) (body []byte, serverPublic []byte, err error) {
	if len(payload) > 3072 {
		return nil, nil, errors.New("push payload exceeds 3072 bytes")
	}
	if len(userPublic) != 65 || userPublic[0] != 4 || len(authSecret) != 16 {
		return nil, nil, errors.New("invalid subscription key material")
	}
	curve := elliptic.P256()
	ux, uy := elliptic.Unmarshal(curve, userPublic)
	if ux == nil || !curve.IsOnCurve(ux, uy) {
		return nil, nil, errors.New("invalid subscription public key")
	}
	serverKey, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	sharedX, _ := curve.ScalarMult(ux, uy, serverKey.D.FillBytes(make([]byte, 32)))
	if sharedX == nil {
		return nil, nil, errors.New("P-256 ECDH failed")
	}
	shared := sharedX.FillBytes(make([]byte, 32))
	serverPublic = elliptic.Marshal(curve, serverKey.X, serverKey.Y)
	keyInfo := append([]byte("WebPush: info\x00"), userPublic...)
	keyInfo = append(keyInfo, serverPublic...)
	ikm := hkdfExpand(hkdfExtract(authSecret, shared), keyInfo, 32)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, nil, err
	}
	prk := hkdfExtract(salt, ikm)
	cek := hkdfExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfExpand(prk, []byte("Content-Encoding: nonce\x00"), 12)
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	record := append(append([]byte(nil), payload...), 0x02)
	ciphertext := gcm.Seal(nil, nonce, record, nil)
	body = make([]byte, 16+4+1+len(serverPublic)+len(ciphertext))
	copy(body, salt)
	binary.BigEndian.PutUint32(body[16:20], 4096)
	body[20] = byte(len(serverPublic))
	copy(body[21:], serverPublic)
	copy(body[21+len(serverPublic):], ciphertext)
	return body, serverPublic, nil
}

func base64Raw(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

func vapidToken(endpoint, subject string, public, private []byte, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", errors.New("invalid push endpoint audience")
	}
	if len(public) != 65 || len(private) != 32 {
		return "", errors.New("invalid VAPID key")
	}
	header := base64Raw([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": subject,
	})
	input := header + "." + base64Raw(claims)
	hash := sha256.Sum256([]byte(input))
	d := new(big.Int).SetBytes(private)
	curve := elliptic.P256()
	if d.Sign() <= 0 || d.Cmp(curve.Params().N) >= 0 {
		return "", errors.New("invalid VAPID private scalar")
	}
	x, y := curve.ScalarBaseMult(private)
	if !bytes.Equal(public, elliptic.Marshal(curve, x, y)) {
		return "", errors.New("VAPID key mismatch")
	}
	r, s, err := ecdsa.Sign(rand.Reader, &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: curve, X: x, Y: y}, D: d}, hash[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return input + "." + base64Raw(signature), nil
}

func (e *Engine) sendWebPush(ctx context.Context, endpoint, p256dh, auth string, payload []byte) (int, error) {
	userPublic, err := canon.DecodeB64URL(p256dh)
	if err != nil || len(userPublic) != 65 {
		return 0, errors.New("invalid stored p256dh")
	}
	authSecret, err := canon.DecodeB64URL(auth)
	if err != nil || len(authSecret) != 16 {
		return 0, errors.New("invalid stored auth")
	}
	body, _, err := encryptWebPush(payload, userPublic, authSecret)
	if err != nil {
		return 0, err
	}
	token, err := vapidToken(endpoint, e.VAPIDSubject, e.VAPIDPublicBytes(), e.VAPIDPrivate, time.Now())
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "vapid t="+token+", k="+e.VAPIDPublic)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "60")
	client := e.PushHTTPClient
	if client == nil {
		client = productionPushHTTPClient()
	}
	requestClient := *client
	requestClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := requestClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusGone {
		return resp.StatusCode, fmt.Errorf("push service returned %s", resp.Status)
	}
	return resp.StatusCode, nil
}

func (e *Engine) VAPIDPublicBytes() []byte {
	public, _ := canon.DecodeB64URL(e.VAPIDPublic)
	return public
}

// DeliverPush sends one encrypted payload to every current subscription for a
// device. HTTP 404/410 responses remove the stale subscription durably.
func (e *Engine) deliverPush(ctx context.Context, deviceID string, payload []byte) error {
	if len(payload) == 0 || len(payload) > 3072 {
		return errors.New("invalid push payload size")
	}
	e.mu.Lock()
	dev := e.Devices[deviceID]
	if dev == nil || dev.RevokedAt != nil {
		e.mu.Unlock()
		return errRevoked
	}
	subs := append([]state.PushSubscription(nil), dev.PushSubscriptions...)
	e.mu.Unlock()
	var failures []error
	live := subs[:0]
	nowMS := time.Now().UnixMilli()
	for _, sub := range subs {
		if sub.ExpirationTime != nil && *sub.ExpirationTime <= nowMS {
			if _, err := e.RemovePushSubscription(deviceID, sub.Endpoint); err != nil {
				failures = append(failures, err)
			}
			continue
		}
		live = append(live, sub)
	}
	subs = live
	var failuresMu sync.Mutex
	var wg sync.WaitGroup
	for _, sub := range subs {
		sub := sub
		acquired := false
		select {
		case e.pushSem <- struct{}{}:
			acquired = true
		case <-ctx.Done():
			failures = append(failures, ctx.Err())
		}
		if !acquired {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-e.pushSem }()
			status, err := e.sendWebPush(ctx, sub.Endpoint, sub.P256DH, sub.Auth, payload)
			if status == http.StatusNotFound || status == http.StatusGone {
				_, cleanupErr := e.RemovePushSubscription(deviceID, sub.Endpoint)
				if cleanupErr != nil {
					failuresMu.Lock()
					failures = append(failures, cleanupErr)
					failuresMu.Unlock()
				}
				return
			}
			if err != nil {
				failuresMu.Lock()
				failures = append(failures, err)
				failuresMu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errors.Join(failures...)
}

func (e *Engine) DeliverPush(deviceID string, payload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return e.deliverPush(ctx, deviceID, payload)
}

// NotifyHerd fans out a privacy-minimized notification to every unrevoked
// subscribed device, with a per-herd/per-kind/per-device 30 second debounce.
func (e *Engine) NotifyHerd(event HerdPush) error {
	if !validID(event.HerdID) {
		return errors.New("valid herd id is required")
	}
	if event.Kind != PushNeedsYou && event.Kind != PushDone {
		return errors.New("push kind is required")
	}
	title, body := pushNotificationCopy(event)
	fragment := url.Values{}
	fragment.Set("notify", "1")
	fragment.Set("d", e.DaemonID)
	fragment.Set("pane", event.HerdID)
	// One system notification represents the latest state of a pane. Keep the
	// delivery debounce separated by kind below, but let a completion replace a
	// stale needs-you notification instead of leaving both in the tray.
	tagSum := sha256.Sum256([]byte(e.DaemonID + "\x00" + event.HerdID))
	payload, _ := json.Marshal(map[string]string{
		"title": title,
		"body":  body,
		"tag":   fmt.Sprintf("pairfob-pane-%x", tagSum[:8]),
		"url":   "/pair#" + fragment.Encode(),
	})
	now := time.Now()
	e.mu.Lock()
	var devices []string
	for id, dev := range e.Devices {
		if dev.RevokedAt != nil || len(dev.PushSubscriptions) == 0 {
			continue
		}
		key := id + "\x00" + event.HerdID + "\x00" + string(event.Kind)
		if last := e.pushLast[key]; !last.IsZero() && now.Sub(last) < pushDebounce {
			continue
		}
		e.pushLast[key] = now
		devices = append(devices, id)
	}
	e.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var failures []error
	var failuresMu sync.Mutex
	var wg sync.WaitGroup
	for _, id := range devices {
		id := id
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := e.deliverPush(ctx, id, payload); err != nil {
				failuresMu.Lock()
				failures = append(failures, err)
				failuresMu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errors.Join(failures...)
}

func (e *Engine) sendPoke(reason, paneID string) {
	params := map[string]any{"reason": reason}
	if paneID != "" {
		params["pane_id"] = paneID
	}
	body, err := json.Marshal(map[string]any{"v": 1, "op": "Poke", "params": params})
	if err != nil {
		return
	}
	e.mu.Lock()
	sessions := make([]*sess, 0, len(e.sessions))
	for _, s := range e.sessions {
		if s.state == "established" {
			sessions = append(sessions, s)
		}
	}
	e.mu.Unlock()
	for _, s := range sessions {
		s.sendMu.Lock()
		e.mu.Lock()
		active := s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
		e.mu.Unlock()
		if !active {
			s.sendMu.Unlock()
			continue
		}
		payload, err := aead.Seal(s.s2c, s.routeID, body)
		if err == nil {
			_ = e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload})
		}
		s.sendMu.Unlock()
	}
}

type runtimeAvailability uint8

const (
	runtimeUnknown runtimeAvailability = iota
	runtimeOffline
	runtimeOnline
)

func transitionRuntimeAvailability(current runtimeAvailability, online bool) (runtimeAvailability, string) {
	next, reason := runtimeOffline, "herdr_offline"
	if online {
		next, reason = runtimeOnline, "herdr_online"
	}
	if current == next {
		return next, ""
	}
	return next, reason
}

// MonitorPush observes snapshot status transitions. It never includes prompt
// text or full cwd in a notification payload.
func (e *Engine) MonitorPush(stop <-chan struct{}, every time.Duration) {
	if every <= 0 {
		every = 2 * time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	type pokeEvent struct{ reason, paneID string }
	pokes := make(chan pokeEvent, 64)
	defer close(pokes)
	go func() {
		for {
			select {
			case <-stop:
				return
			case event, ok := <-pokes:
				if !ok {
					return
				}
				e.sendPoke(event.reason, event.paneID)
			}
		}
	}()
	emitPoke := func(reason, paneID string) {
		select {
		case pokes <- pokeEvent{reason: reason, paneID: paneID}:
		default:
			// Pokes are refresh hints. A stalled transport must never stall
			// runtime monitoring; the next transition/snapshot will converge.
		}
	}
	statusByPane := map[string]string{}
	availability := runtimeUnknown
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			snapshot, err := e.snapshot(nil)
			nextAvailability, availabilityPoke := transitionRuntimeAvailability(availability, err == nil)
			availability = nextAvailability
			if availabilityPoke != "" {
				emitPoke(availabilityPoke, "")
			}
			if err != nil {
				continue
			}
			labels := map[string]string{}
			for _, workspace := range snapshot.Workspaces {
				labels[workspace.WorkspaceID] = workspace.Label
			}
			tabLabels := map[string]string{}
			for _, tab := range snapshot.Tabs {
				tabLabels[tab.TabID] = tab.Label
			}
			seen := map[string]string{}
			for _, pane := range snapshot.Panes {
				previous, known := statusByPane[pane.PaneID]
				seen[pane.PaneID] = pane.AgentStatus
				if !known || previous != pane.AgentStatus {
					emitPoke("agent_status", pane.PaneID)
				}
				if kind, notify := pushKindForTransition(previous, known, pane.AgentStatus); notify && e.PushEnabled {
					event := HerdPush{
						HerdID: pane.PaneID, Agent: pane.Agent, WorkspaceLabel: labels[pane.WorkspaceID],
						Cwd: pane.Cwd, PaneLabel: optionalText(pane.Label), TerminalTitle: pane.TerminalTitle,
						TabLabel: tabLabels[pane.TabID], Kind: kind,
					}
					go func(event HerdPush) { _ = e.NotifyHerd(event) }(event)
				}
			}
			statusByPane = seen
		}
	}
}
