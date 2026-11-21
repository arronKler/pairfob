package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"

	"pairfob/internal/remotedesktop"
)

// Engine.mu owns the single reservation, including while capture is starting.
type desktopSlot struct {
	released    chan struct{}
	grantID     string
	owner       *sess
	id          string
	cancel      context.CancelFunc
	ctx         context.Context
	stream      remotedesktop.Stream
	control     bool
	sequence    uint64
	lease       *time.Timer
	closeReason string
}

const maxDesktopEnded = 32

type desktopEndedEntry struct {
	owner  *sess
	reason string
}

type desktopEndedLog struct {
	byID  map[string]desktopEndedEntry
	order []string
}

func (e *Engine) recordDesktopEndedLocked(id string, owner *sess, reason string) {
	if id == "" || owner == nil || reason == "" {
		return
	}
	if e.desktopEnded.byID == nil {
		e.desktopEnded.byID = make(map[string]desktopEndedEntry, maxDesktopEnded)
	}
	if _, exists := e.desktopEnded.byID[id]; !exists {
		for len(e.desktopEnded.order) >= maxDesktopEnded {
			oldest := e.desktopEnded.order[0]
			e.desktopEnded.order = e.desktopEnded.order[1:]
			delete(e.desktopEnded.byID, oldest)
		}
		e.desktopEnded.order = append(e.desktopEnded.order, id)
	}
	e.desktopEnded.byID[id] = desktopEndedEntry{owner: owner, reason: reason}
}

func streamCloseReason(stream remotedesktop.Stream) string {
	if stream == nil {
		return ""
	}
	if cr, ok := stream.(interface{ CloseReason() string }); ok {
		return cr.CloseReason()
	}
	return ""
}

func (e *Engine) desktopPolicy() remotedesktop.Policy {
	if e.Desktop == nil || e.Direct == nil {
		return remotedesktop.Policy{}
	}
	return e.Desktop.Policy()
}

func (e *Engine) rpcDesktopOpen(s *sess, id string, raw json.RawMessage) {
	var req remotedesktop.Request
	if badParams(raw, &req) || !operationName.MatchString(req.OperationID) || len(req.SDP) == 0 || len(req.SDP) > maxSDPBytes ||
		(req.Quality != "balanced" && req.Quality != "detail" && req.Quality != "motion") {
		e.replyErr(s, id, "invalid_argument", "invalid desktop offer")
		return
	}
	policy := e.desktopPolicy()
	if !policy.View || (req.Control && !policy.Control) {
		e.replyErr(s, id, "unsupported", "desktop access is disabled on this computer")
		return
	}
	e.mu.Lock()
	if !e.desktopLiveLocked(s) {
		e.mu.Unlock()
		e.replyErr(s, id, "forbidden", "desktop requires a direct connection")
		return
	}
	if s.desktopOpens == nil {
		s.desktopOpens = map[string]bool{}
	}
	if s.desktopOpens[req.OperationID] || len(s.desktopOpens) >= 128 {
		e.mu.Unlock()
		e.replyErr(s, id, "conflict", "duplicate or exhausted desktop request")
		return
	}
	if e.desktopPreempting {
		e.mu.Unlock()
		e.replyErr(s, id, "conflict", "the desktop is already in use")
		return
	}
	if prev := e.desktop; prev != nil {
		if prev.owner == nil || prev.owner.deviceID == "" || prev.owner.deviceID != s.deviceID {
			e.mu.Unlock()
			e.replyErr(s, id, "conflict", "the desktop is already in use")
			return
		}
		e.desktopPreempting = true
		prev.closeReason = "preempted"
		prev.cancel()
		e.mu.Unlock()

		timer := time.NewTimer(1500 * time.Millisecond)
		select {
		case <-prev.released:
			timer.Stop()
		case <-timer.C:
		}

		e.mu.Lock()
		e.desktopPreempting = false
		policy = e.desktopPolicy()
		if !e.desktopLiveLocked(s) {
			e.mu.Unlock()
			e.replyErr(s, id, "forbidden", "desktop requires a direct connection")
			return
		}
		if e.desktop != nil {
			e.mu.Unlock()
			e.replyErr(s, id, "conflict", "the desktop is already in use")
			return
		}
		if !policy.View || (req.Control && !policy.Control) {
			e.mu.Unlock()
			e.replyErr(s, id, "unsupported", "desktop access is disabled on this computer")
			return
		}
		if s.desktopOpens[req.OperationID] || len(s.desktopOpens) >= 128 {
			e.mu.Unlock()
			e.replyErr(s, id, "conflict", "duplicate or exhausted desktop request")
			return
		}
	}
	s.desktopOpens[req.OperationID] = true
	ctx, cancel := context.WithCancel(s.outputContext())
	slot := &desktopSlot{released: make(chan struct{}), grantID: policy.GrantID, owner: s, id: req.OperationID, ctx: ctx, cancel: cancel}
	e.desktop = slot
	label := s.deviceID
	if device := e.Devices[s.deviceID]; device != nil && device.Label != "" {
		label = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
				return -1
			}
			return r
		}, device.Label) + " (" + s.deviceID + ")"
	}
	e.mu.Unlock()
	go e.startDesktop(slot, id, label, req)
}

func (e *Engine) desktopLiveLocked(s *sess) bool {
	return s != nil && s.state == "established" && s.sendEpochLive() && s.transport == "p2p" && e.sessions[s.routeID] == s
}

func (e *Engine) startDesktop(slot *desktopSlot, id, label string, req remotedesktop.Request) {
	var stream remotedesktop.Stream
	opened := false
	defer func() {
		slot.cancel()
		if stream != nil {
			<-stream.Done()
		}
		e.mu.Lock()
		if slot.lease != nil {
			slot.lease.Stop()
		}
		reason := slot.closeReason
		if reason == "" {
			reason = streamCloseReason(stream)
		}
		if reason != "" {
			e.recordDesktopEndedLocked(slot.id, slot.owner, reason)
		}
		if e.desktop == slot {
			e.desktop = nil
		}
		e.mu.Unlock()
		if opened {
			fields := map[string]any{"device_id": slot.owner.deviceID}
			if reason != "" {
				fields["reason"] = reason
			}
			e.audit("desktop_closed", fields)
		}
		close(slot.released)
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-slot.ctx.Done():
				return
			case <-ticker.C:
				p := e.desktopPolicy()
				if p.GrantID != slot.grantID || !p.View || (req.Control && !p.Control) {
					slot.cancel()
					return
				}
			}
		}
	}()
	pending := time.AfterFunc(60*time.Second, slot.cancel)
	var result remotedesktop.Result
	var err error
	stream, result, err = e.Desktop.Open(slot.ctx, label, req)
	pending.Stop()
	if err != nil || slot.ctx.Err() != nil {
		e.mu.Lock()
		reason := slot.closeReason
		e.mu.Unlock()
		if reason == "preempted" {
			e.audit("desktop_open_failed", map[string]any{"device_id": slot.owner.deviceID, "reason": reason})
			e.replyErr(slot.owner, id, "kicked", "desktop session taken over by another window")
			return
		}
		message := "desktop startup expired or was cancelled"
		if err != nil && !errors.Is(err, context.Canceled) {
			err = remotedesktop.NormalizeReasonError(err, "")
			message = err.Error()
		}
		fields := map[string]any{"device_id": slot.owner.deviceID}
		if r := remotedesktop.ParseReasonCode(message); r != "" {
			fields["reason"] = r
		}
		e.audit("desktop_open_failed", fields)
		e.replyErr(slot.owner, id, "conflict", message)
		return
	}
	e.mu.Lock()
	policy := e.desktopPolicy()
	if !e.desktopLiveLocked(slot.owner) || slot.ctx.Err() != nil || policy.GrantID != slot.grantID || !policy.View || (req.Control && !policy.Control) {
		reason := slot.closeReason
		e.mu.Unlock()
		if reason == "preempted" {
			e.audit("desktop_open_failed", map[string]any{"device_id": slot.owner.deviceID, "reason": reason})
			e.replyErr(slot.owner, id, "kicked", "desktop session taken over by another window")
			return
		}
		e.replyErr(slot.owner, id, "forbidden", "desktop permission changed during startup")
		return
	}
	slot.stream, slot.control = stream, req.Control && result.Control
	slot.lease = time.AfterFunc(12*time.Second, slot.cancel)
	e.mu.Unlock()
	opened = true
	e.audit("desktop_open", map[string]any{"device_id": slot.owner.deviceID, "control": slot.control, "audio": result.Audio})
	if !e.reply(slot.owner, id, result) {
		return
	}
	select {
	case <-stream.Done():
	case <-slot.ctx.Done():
	}
}

type desktopCommand struct {
	Desktop   string               `json:"desktop_id"`
	Operation string               `json:"operation_id,omitempty"`
	Sequence  uint64               `json:"sequence,omitempty"`
	Observe   bool                 `json:"observe,omitempty"`
	Keyframe  bool                 `json:"keyframe,omitempty"`
	Event     *remotedesktop.Event `json:"event,omitempty"`
}

func (e *Engine) rpcDesktopCommand(s *sess, id, op string, raw json.RawMessage) {
	var p desktopCommand
	if badParams(raw, &p) || !operationName.MatchString(p.Desktop) || (p.Observe && op != "DesktopPing") || (p.Keyframe && !p.Observe) {
		e.replyErr(s, id, "invalid_argument", "invalid desktop session")
		return
	}
	policy := e.desktopPolicy()
	e.mu.Lock()
	slot := e.desktop
	live := e.desktopLiveLocked(s)
	owned := slot != nil && slot.owner == s && slot.id == p.Desktop
	if live && op == "DesktopClose" && operationName.MatchString(p.Operation) && p.Event == nil && p.Sequence == 0 && s.desktopOpens[p.Desktop] {
		if !owned {
			// The media peer may have stopped before the close RPC arrived.
			e.mu.Unlock()
			e.reply(s, id, struct{}{})
			return
		}
		slot.cancel()
		e.mu.Unlock()
		go func() {
			select {
			case <-slot.released:
				e.reply(s, id, struct{}{})
			case <-s.outputContext().Done():
			}
		}()
		return
	}
	if !live || !owned || slot.ctx.Err() != nil {
		var endedReason string
		if live && !owned {
			if entry, ok := e.desktopEnded.byID[p.Desktop]; ok && entry.owner == s {
				endedReason = entry.reason
			}
		} else if live && owned && slot.ctx.Err() != nil {
			endedReason = slot.closeReason
			if endedReason == "" {
				endedReason = streamCloseReason(slot.stream)
			}
		}
		e.mu.Unlock()
		switch {
		case endedReason == "preempted":
			e.replyErr(s, id, "kicked", "desktop session taken over by another window")
		case endedReason != "":
			e.replyErr(s, id, "forbidden", "[reason:"+endedReason+"] desktop session is closed")
		default:
			e.replyErr(s, id, "forbidden", "desktop session is closed")
		}
		return
	}
	if policy.GrantID != slot.grantID || !policy.View || (slot.control && !policy.Control) {
		slot.cancel()
		e.mu.Unlock()
		e.replyErr(s, id, "forbidden", "desktop permission revoked")
		return
	}
	if slot.stream == nil {
		e.mu.Unlock()
		e.replyErr(s, id, "conflict", "desktop stream is starting")
		return
	}
	if op == "DesktopPing" && p.Event == nil && p.Operation == "" && p.Sequence == 0 {
		slot.lease.Reset(4 * time.Second)
		observer, ok := slot.stream.(interface {
			Observe(bool, bool) remotedesktop.StreamObservation
		})
		e.mu.Unlock()
		if ok {
			e.reply(s, id, observer.Observe(p.Observe, p.Keyframe))
		} else {
			e.reply(s, id, struct{}{})
		}
		return
	}
	if op != "DesktopInput" || !slot.control || p.Event == nil || !p.Event.Valid() || p.Sequence != slot.sequence+1 || p.Operation != slot.id+"_"+strconv.FormatUint(p.Sequence, 10) {
		e.mu.Unlock()
		e.replyErr(s, id, "forbidden", "invalid or stale desktop input")
		return
	}
	slot.sequence = p.Sequence
	stream := slot.stream
	e.mu.Unlock()
	if err := stream.Input(*p.Event); err != nil {
		slot.cancel()
		e.replyErr(s, id, "unknown_outcome", "desktop input interrupted")
		return
	}
	e.reply(s, id, struct{}{})
}
