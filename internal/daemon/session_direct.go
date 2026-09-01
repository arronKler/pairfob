package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

const (
	directOfferTimeout   = 6 * time.Second
	directReadyTTL       = 20 * time.Second
	directRestartTimeout = 20 * time.Second
	maxSDPBytes          = 64 * 1024
)

var directAttemptPattern = regexp.MustCompile(`^p2p_[A-Za-z0-9_-]{16,64}$`)
var directRoutePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

type transportOfferParams struct {
	AttemptID string `json:"attempt_id"`
	SDP       string `json:"sdp"`
}

type transportCommitParams struct {
	AttemptID string `json:"attempt_id"`
	RouteID   string `json:"route_id"`
}

type transportRestartParams struct {
	AttemptID string `json:"attempt_id"`
	SDP       string `json:"sdp"`
}

type directRestarter interface {
	Restart(context.Context, string) (string, error)
}

func validDirectSDP(sdp string) bool {
	return len(sdp) > 0 && len(sdp) <= maxSDPBytes && !strings.ContainsRune(sdp, '\x00') &&
		strings.HasPrefix(sdp, "v=0") && strings.Contains(sdp, "m=application")
}

func (e *Engine) newDirectRoute() ([16]byte, error) {
	for i := 0; i < 4; i++ {
		var route [16]byte
		if _, err := rand.Read(route[:]); err != nil {
			return [16]byte{}, err
		}
		e.mu.Lock()
		_, exists := e.sessions[route]
		e.mu.Unlock()
		if !exists && route != ([16]byte{}) {
			return route, nil
		}
	}
	return [16]byte{}, errors.New("direct route collision")
}

func (e *Engine) rpcTransportOffer(parent *sess, id string, params json.RawMessage) {
	var input transportOfferParams
	if badParams(params, &input) || !directAttemptPattern.MatchString(input.AttemptID) || !validDirectSDP(input.SDP) {
		e.replyErr(parent, id, "invalid_argument", "invalid WebRTC offer")
		return
	}
	if e.Direct == nil {
		e.replyErr(parent, id, "unsupported", "P2P transport unavailable")
		return
	}
	e.mu.Lock()
	parentActive := parent.state == "established" && parent.transport == "relay" && e.sessions[parent.routeID] == parent
	parentBusy := parent.directBusy
	if parentActive && !parentBusy {
		parent.directBusy = true
	}
	e.mu.Unlock()
	if !parentActive {
		e.replyErr(parent, id, "unsupported", "P2P transport unavailable")
		return
	}
	if parentBusy {
		e.replyErr(parent, id, "conflict", "P2P negotiation already active")
		return
	}
	defer func() {
		e.mu.Lock()
		parent.directBusy = false
		e.mu.Unlock()
	}()
	route, err := e.newDirectRoute()
	if err != nil {
		e.replyErr(parent, id, "internal", "could not allocate P2P route")
		return
	}

	candidate := &sess{
		routeID: route, deviceID: parent.deviceID, state: "resumehello", transport: "p2p",
		upgradeFrom: parent.routeID, attemptID: input.AttemptID,
		rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), rpcStop: make(chan struct{}),
	}
	ctx, cancel := context.WithTimeout(context.Background(), directOfferTimeout)
	defer cancel()
	answer, conn, err := e.Direct.Accept(ctx, input.SDP, func(link mux.Conn, frame envelope.Frame) {
		e.handleDirectFrame(route, link, frame)
	}, func(link mux.Conn) {
		e.handleDirectClose(route, link)
	})
	if err != nil {
		e.replyErr(parent, id, "unsupported", "P2P negotiation failed")
		e.audit("p2p_offer_failed", map[string]any{"device_id": parent.deviceID})
		return
	}
	if conn == nil || !validDirectSDP(answer) {
		if conn != nil {
			conn.Close()
		}
		e.replyErr(parent, id, "unsupported", "P2P negotiation failed")
		return
	}
	candidate.link = conn

	e.mu.Lock()
	if parent.state != "established" || e.sessions[parent.routeID] != parent {
		e.mu.Unlock()
		conn.Close()
		e.replyErr(parent, id, "conflict", "relay session changed")
		return
	}
	var replaced *sess
	for candidateRoute, other := range e.sessions {
		if other.upgradeFrom == parent.routeID {
			replaced = other
			delete(e.sessions, candidateRoute)
			replaced.state = "closed"
			break
		}
	}
	e.sessions[route] = candidate
	e.mu.Unlock()
	if replaced != nil {
		stopSessionRPC(replaced)
		replaced.sendMu.Lock()
		e.wipeSession(replaced)
		replaced.sendMu.Unlock()
		if replaced.link != nil {
			replaced.link.Close()
		}
	}
	go e.runSessionRPC(candidate)
	time.AfterFunc(directReadyTTL, func() { e.expireDirectCandidate(route, candidate) })

	if !e.reply(parent, id, map[string]any{
		"attempt_id": input.AttemptID,
		"route_id":   hex.EncodeToString(route[:]),
		"sdp":        answer,
	}) {
		e.expireDirectCandidate(route, candidate)
		return
	}
	e.audit("p2p_offer", map[string]any{"device_id": parent.deviceID})
}

func (e *Engine) expireDirectCandidate(route [16]byte, candidate *sess) {
	e.mu.Lock()
	if e.sessions[route] != candidate || candidate.state == "established" {
		e.mu.Unlock()
		return
	}
	delete(e.sessions, route)
	candidate.state = "closed"
	e.mu.Unlock()
	stopSessionRPC(candidate)
	candidate.sendMu.Lock()
	e.wipeSession(candidate)
	candidate.sendMu.Unlock()
	if candidate.link != nil {
		candidate.link.Close()
	}
}

func (e *Engine) handleDirectFrame(route [16]byte, conn mux.Conn, frame envelope.Frame) {
	if frame.Version != 1 || frame.RouteID != route {
		conn.Close()
		return
	}
	if frame.Typ == envelope.TypPING {
		if len(frame.Payload) != 8 {
			conn.Close()
			return
		}
		_ = conn.Send(envelope.Frame{Version: 1, Typ: envelope.TypPONG, RouteID: route, Payload: append([]byte(nil), frame.Payload...)})
		return
	}
	if frame.Typ != envelope.TypFWD {
		conn.Close()
		return
	}
	e.mu.Lock()
	s := e.sessions[route]
	active := s != nil && s.link == conn
	e.mu.Unlock()
	if active {
		e.handleSessFWD(frame, s)
	}
}

func (e *Engine) handleDirectClose(route [16]byte, conn mux.Conn) {
	e.mu.Lock()
	s := e.sessions[route]
	active := s != nil && s.link == conn
	e.mu.Unlock()
	if active {
		e.closeSession(route, "", false)
		e.audit("p2p_closed", map[string]any{"device_id": s.deviceID})
	}
}

// rpcTransportCommit sends the final reply over relay, then switches the same
// logical session (including its live terminal) to the fresh P2P key epoch.
func (e *Engine) rpcTransportCommit(parent *sess, id string, params json.RawMessage) {
	var input transportCommitParams
	if badParams(params, &input) || !directAttemptPattern.MatchString(input.AttemptID) || !directRoutePattern.MatchString(input.RouteID) {
		e.replyErr(parent, id, "invalid_argument", "invalid P2P commit")
		return
	}
	rawRoute, err := hex.DecodeString(input.RouteID)
	if err != nil || len(rawRoute) != 16 {
		e.replyErr(parent, id, "invalid_argument", "invalid P2P route")
		return
	}
	var route [16]byte
	copy(route[:], rawRoute)

	e.mu.Lock()
	candidate := e.sessions[route]
	e.mu.Unlock()
	if candidate == nil {
		e.replyErr(parent, id, "conflict", "P2P candidate expired")
		return
	}

	parent.sendMu.Lock()
	candidate.sendMu.Lock()

	e.mu.Lock()
	valid := parent.state == "established" && parent.transport == "relay" &&
		e.sessions[parent.routeID] == parent && candidate.state == "upgrade_ready" &&
		candidate.upgradeFrom == parent.routeID && candidate.deviceID == parent.deviceID &&
		candidate.attemptID == input.AttemptID && candidate.link != nil
	if !valid {
		e.mu.Unlock()
		candidate.sendMu.Unlock()
		parent.sendMu.Unlock()
		e.replyErr(parent, id, "conflict", "P2P candidate is not ready")
		return
	}
	oldRoute := parent.routeID
	oldLink := parent.link
	body, marshalErr := json.Marshal(map[string]any{
		"v": 1, "id": id, "ok": true,
		"result": map[string]any{"attempt_id": input.AttemptID, "route_id": input.RouteID, "transport": "webrtc"},
	})
	if marshalErr != nil || len(body) > aead.MaxPlaintext {
		e.mu.Unlock()
		candidate.sendMu.Unlock()
		parent.sendMu.Unlock()
		return
	}
	payload, sealErr := aead.Seal(parent.s2c, oldRoute, body)
	if sealErr != nil {
		e.mu.Unlock()
		candidate.sendMu.Unlock()
		parent.sendMu.Unlock()
		return
	}
	e.mu.Unlock()
	if oldLink.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: oldRoute, Payload: payload}) != nil {
		candidate.sendMu.Unlock()
		parent.sendMu.Unlock()
		return
	}

	e.mu.Lock()
	if e.sessions[oldRoute] != parent || e.sessions[route] != candidate {
		e.mu.Unlock()
		candidate.sendMu.Unlock()
		parent.sendMu.Unlock()
		return
	}
	delete(e.sessions, oldRoute)
	delete(e.sessions, route)
	parent.routeID = route
	parent.link = candidate.link
	parent.transport = "p2p"
	e.wipeSession(parent)
	parent.c2s, parent.s2c = candidate.c2s, candidate.s2c
	candidate.c2s, candidate.s2c = nil, nil
	candidate.link = nil
	candidate.state = "closed"
	e.wipeSession(candidate)
	parent.upgradeFrom = [16]byte{}
	parent.attemptID = ""
	e.sessions[route] = parent
	e.byDevice[parent.deviceID] = route
	e.mu.Unlock()
	candidate.sendMu.Unlock()
	parent.sendMu.Unlock()
	stopSessionRPC(candidate)
	e.audit("p2p_committed", map[string]any{"device_id": parent.deviceID})
}

func (e *Engine) rpcTransportRestart(parent *sess, id string, params json.RawMessage) {
	var input transportRestartParams
	if badParams(params, &input) || !directAttemptPattern.MatchString(input.AttemptID) || !validDirectSDP(input.SDP) {
		e.replyErr(parent, id, "invalid_argument", "invalid WebRTC restart")
		return
	}
	e.mu.Lock()
	parentActive := parent.state == "established" && parent.transport == "p2p" && e.sessions[parent.routeID] == parent
	parentBusy := parent.directBusy
	link := parent.link
	if parentActive && !parentBusy {
		parent.directBusy = true
	}
	e.mu.Unlock()
	if !parentActive {
		e.replyErr(parent, id, "unsupported", "P2P restart unavailable")
		return
	}
	if parentBusy {
		e.replyErr(parent, id, "conflict", "P2P negotiation already active")
		return
	}
	defer func() {
		e.mu.Lock()
		parent.directBusy = false
		e.mu.Unlock()
	}()
	restarter, ok := link.(directRestarter)
	if !ok || link == nil {
		e.replyErr(parent, id, "unsupported", "P2P restart unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), directRestartTimeout)
	defer cancel()
	answer, err := restarter.Restart(ctx, input.SDP)
	if err != nil || !validDirectSDP(answer) {
		e.replyErr(parent, id, "unsupported", "P2P restart failed")
		e.audit("p2p_restart_failed", map[string]any{"device_id": parent.deviceID})
		return
	}
	if !e.reply(parent, id, map[string]any{"attempt_id": input.AttemptID, "sdp": answer}) {
		return
	}
	e.audit("p2p_restart", map[string]any{"device_id": parent.deviceID})
}
