package daemon

import (
	"context"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func validateSubscription(endpoint, p256dh, auth string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(endpoint) > 4096 {
		return "", errors.New("invalid push endpoint")
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "", errors.New("push endpoint must not target localhost")
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()) {
		return "", errors.New("push endpoint must not target a private address")
	}
	key, err := decodeB64Len(p256dh, 65)
	if err != nil || key[0] != 4 {
		return "", errors.New("invalid p256dh")
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), key)
	if x == nil || !elliptic.P256().IsOnCurve(x, y) {
		return "", errors.New("invalid p256dh point")
	}
	if _, err := decodeB64Len(auth, 16); err != nil {
		return "", errors.New("invalid auth")
	}
	return host, nil
}

func decodeB64Len(value string, n int) ([]byte, error) {
	// state keys use the same unpadded base64url codec as the wire protocol.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	if value == "" || strings.ContainsFunc(value, func(r rune) bool { return !strings.ContainsRune(alphabet, r) }) {
		return nil, errors.New("invalid base64url")
	}
	// Reuse the protocol decoder without accepting padding.
	decoded, err := canon.DecodeB64URL(value)
	if err != nil || len(decoded) != n {
		return nil, errors.New("invalid base64url length")
	}
	return decoded, nil
}

func (e *Engine) dispatchPushSubscribe(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID    string `json:"operation_id"`
		Endpoint       string `json:"endpoint"`
		P256DH         string `json:"p256dh"`
		Auth           string `json:"auth"`
		ExpirationTime *int64 `json:"expirationTime"`
	}
	if badParams(params, &p) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	operationID, ok := mutationOperationID(p.OperationID, id, true)
	if !ok {
		e.replyErr(s, id, "invalid_argument", "invalid operation_id")
		return
	}
	host, err := validateSubscription(p.Endpoint, p.P256DH, p.Auth)
	if err != nil {
		e.replyErr(s, id, "bad_token", err.Error())
		return
	}
	if p.ExpirationTime != nil && *p.ExpirationTime <= time.Now().UnixMilli() {
		e.replyErr(s, id, "bad_token", "push subscription is expired")
		return
	}
	intent := struct {
		Endpoint       string `json:"endpoint"`
		P256DH         string `json:"p256dh"`
		Auth           string `json:"auth"`
		ExpirationTime *int64 `json:"expiration_time"`
	}{Endpoint: p.Endpoint, P256DH: p.P256DH, Auth: p.Auth, ExpirationTime: p.ExpirationTime}
	receipt, mutationErr := e.executeTrackedMutation(context.Background(), s.deviceID, runtime.DefaultSession(), operationID, intent, func() (runtime.Receipt, error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		dev := e.Devices[s.deviceID]
		if dev == nil || dev.RevokedAt != nil {
			return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeNotApplied}, errRevoked
		}
		now := time.Now().Unix()
		sub := state.PushSubscription{
			Endpoint: p.Endpoint, P256DH: p.P256DH, Auth: p.Auth,
			ExpirationTime: p.ExpirationTime, Created: now,
		}
		previousSubscriptions := append([]state.PushSubscription(nil), dev.PushSubscriptions...)
		replaced := false
		for i := range dev.PushSubscriptions {
			if dev.PushSubscriptions[i].Endpoint == p.Endpoint {
				dev.PushSubscriptions[i] = sub
				replaced = true
				break
			}
		}
		if !replaced {
			if len(dev.PushSubscriptions) >= 16 {
				return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeNotApplied}, errors.New("subscription limit reached")
			}
			dev.PushSubscriptions = append(dev.PushSubscriptions, sub)
		}
		if saveErr := e.saveDevicesLocked(); saveErr != nil {
			dev.PushSubscriptions = previousSubscriptions
			return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeNotApplied}, saveErr
		}
		return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeApplied}, nil
	})
	if mutationErr != nil {
		if errors.Is(mutationErr, errRevoked) {
			e.replyErr(s, id, "revoked", "device revoked")
		} else if strings.Contains(mutationErr.Error(), "subscription limit") {
			e.replyErr(s, id, "too_large", "subscription limit reached")
		} else {
			e.replyErr(s, id, "internal", "persistent subscription update failed")
		}
		return
	}
	e.audit("push_subscribe", map[string]any{"device_id": s.deviceID, "endpoint_host": host})
	e.reply(s, id, map[string]any{"ok": true, "delivery": "webpush", "operation_id": operationID, "outcome": receipt.Outcome})
}

// RemovePushSubscription is the delivery layer's 404/410 cleanup hook.
func (e *Engine) RemovePushSubscription(deviceID, endpoint string) (bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	dev := e.Devices[deviceID]
	if dev == nil {
		return false, errRevoked
	}
	for i := range dev.PushSubscriptions {
		if dev.PushSubscriptions[i].Endpoint == endpoint {
			previousSubscriptions := append([]state.PushSubscription(nil), dev.PushSubscriptions...)
			dev.PushSubscriptions = append(dev.PushSubscriptions[:i], dev.PushSubscriptions[i+1:]...)
			if err := e.saveDevicesLocked(); err != nil {
				dev.PushSubscriptions = previousSubscriptions
				return false, err
			}
			return true, nil
		}
	}
	return false, nil
}
