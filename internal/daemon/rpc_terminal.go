package daemon

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/runtime"
)

const (
	maxTerminalInputBytes = 32 * 1024
	terminalFrameChunk    = 96 * 1024
	maxTerminalFrameBytes = 4 << 20
)

type terminalSlot struct {
	id          string
	paneID      string
	controller  runtime.TerminalController
	commandMu   sync.Mutex
	nextCommand uint64
}

func (e *Engine) rpcTerminalOpen(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string  `json:"operation_id"`
		Session     *string `json:"session"`
		PaneID      string  `json:"pane_id"`
		Cols        int     `json:"cols"`
		Rows        int     `json:"rows"`
		Takeover    bool    `json:"takeover"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || invalidSession(p.Session) ||
		!validID(p.PaneID) || !runtime.ValidTerminalSize(p.Cols, p.Rows) {
		e.replyErr(s, id, "invalid_argument", "invalid terminal open params")
		return
	}
	opener, ok := e.RT.(runtime.TerminalOpener)
	if !ok {
		e.replyErr(s, id, "unsupported", "the live runtime does not support terminal streams")
		return
	}
	pane, err := e.findPane(p.Session, p.PaneID)
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	if pane == nil {
		e.replyErr(s, id, "pane_not_found", "pane is no longer available")
		return
	}
	s.terminalMu.Lock()
	occupied := s.terminal != nil
	s.terminalMu.Unlock()
	if occupied {
		// A response can be lost while the Established socket survives. A fresh
		// open from the same phone session replaces that unreachable controller;
		// Herdr still enforces takeover against controllers owned elsewhere.
		closeSessionTerminal(s)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	controller, err := opener.OpenTerminal(ctx, runtime.TerminalOpen{
		Session: runtimeSession(p.Session), PaneID: p.PaneID, Cols: p.Cols, Rows: p.Rows, Takeover: p.Takeover,
	})
	cancel()
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	terminalID, err := newTerminalID()
	if err != nil {
		_ = controller.Close()
		e.replyErr(s, id, "internal", "could not create terminal session")
		return
	}
	slot := &terminalSlot{id: terminalID, paneID: p.PaneID, controller: controller, nextCommand: 1}
	s.terminalMu.Lock()
	if s.terminal != nil {
		s.terminalMu.Unlock()
		_ = controller.Close()
		e.replyErr(s, id, "conflict", "this phone session already controls a terminal")
		return
	}
	s.terminal = slot
	s.terminalMu.Unlock()
	if !e.reply(s, id, map[string]any{
		"operation_id": p.OperationID, "terminal_id": slot.id, "pane_id": slot.paneID,
		"cols": p.Cols, "rows": p.Rows, "encoding": "ansi",
	}) {
		closeSessionTerminal(s)
		return
	}
	e.audit("terminal_open", map[string]any{
		"device_id": s.deviceID, "operation_id": p.OperationID, "pane_id": p.PaneID,
		"cols": p.Cols, "rows": p.Rows, "takeover": p.Takeover,
	})
	go e.forwardTerminal(s, slot)
}

func (e *Engine) rpcTerminalInput(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string  `json:"operation_id"`
		TerminalID  string  `json:"terminal_id"`
		Sequence    *uint64 `json:"seq"`
		Data        string  `json:"data"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || p.Sequence == nil || *p.Sequence == 0 || p.Data == "" {
		e.replyErr(s, id, "invalid_argument", "invalid terminal input params")
		return
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil || len(data) == 0 || base64.StdEncoding.EncodeToString(data) != p.Data {
		e.replyErr(s, id, "invalid_argument", "terminal input is not canonical base64")
		return
	}
	if len(data) > maxTerminalInputBytes {
		e.replyErr(s, id, "too_large", "terminal input is too large")
		return
	}
	e.runTerminalCommand(s, id, p.OperationID, p.TerminalID, *p.Sequence, func(controller runtime.TerminalController) error {
		return controller.Input(data)
	}, "terminal_input", map[string]any{"bytes": len(data)})
}

func (e *Engine) rpcTerminalResize(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string  `json:"operation_id"`
		TerminalID  string  `json:"terminal_id"`
		Sequence    *uint64 `json:"seq"`
		Cols        int     `json:"cols"`
		Rows        int     `json:"rows"`
		CellWidth   int     `json:"cell_width_px"`
		CellHeight  int     `json:"cell_height_px"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || p.Sequence == nil || *p.Sequence == 0 || !runtime.ValidTerminalSize(p.Cols, p.Rows) ||
		p.CellWidth < 0 || p.CellHeight < 0 || p.CellWidth > 4096 || p.CellHeight > 4096 {
		e.replyErr(s, id, "invalid_argument", "invalid terminal resize params")
		return
	}
	e.runTerminalCommand(s, id, p.OperationID, p.TerminalID, *p.Sequence, func(controller runtime.TerminalController) error {
		return controller.Resize(runtime.TerminalResize{
			Cols: p.Cols, Rows: p.Rows, CellWidthPX: p.CellWidth, CellHeightPX: p.CellHeight,
		})
	}, "terminal_resize", map[string]any{"cols": p.Cols, "rows": p.Rows})
}

func (e *Engine) rpcTerminalScroll(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string  `json:"operation_id"`
		TerminalID  string  `json:"terminal_id"`
		Sequence    *uint64 `json:"seq"`
		Direction   string  `json:"direction"`
		Lines       int     `json:"lines"`
		Source      string  `json:"source"`
		Column      *int    `json:"column"`
		Row         *int    `json:"row"`
		Modifiers   int     `json:"modifiers"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || p.Sequence == nil || *p.Sequence == 0 || (p.Direction != "up" && p.Direction != "down") ||
		p.Lines < 1 || p.Lines > 160 || (p.Source != "wheel" && p.Source != "page_key") ||
		(p.Column != nil && (*p.Column < 0 || *p.Column > runtime.TerminalMaxCols)) ||
		(p.Row != nil && (*p.Row < 0 || *p.Row > runtime.TerminalMaxRows)) || p.Modifiers < 0 || p.Modifiers > 255 {
		e.replyErr(s, id, "invalid_argument", "invalid terminal scroll params")
		return
	}
	e.runTerminalCommand(s, id, p.OperationID, p.TerminalID, *p.Sequence, func(controller runtime.TerminalController) error {
		return controller.Scroll(runtime.TerminalScroll{
			Direction: p.Direction, Lines: p.Lines, Source: p.Source, Column: p.Column, Row: p.Row, Modifiers: p.Modifiers,
		})
	}, "terminal_scroll", map[string]any{"direction": p.Direction, "lines": p.Lines, "source": p.Source})
}

func (e *Engine) rpcTerminalClose(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string `json:"operation_id"`
		TerminalID  string `json:"terminal_id"`
	}
	if badParams(params, &p) || !operationName.MatchString(p.OperationID) || p.TerminalID == "" {
		e.replyErr(s, id, "invalid_argument", "invalid terminal close params")
		return
	}
	s.terminalMu.Lock()
	slot := s.terminal
	if slot == nil || slot.id != p.TerminalID {
		s.terminalMu.Unlock()
		e.replyErr(s, id, "conflict", "terminal session is no longer active")
		return
	}
	s.terminalMu.Unlock()
	slot.commandMu.Lock()
	s.terminalMu.Lock()
	if s.terminal != slot {
		s.terminalMu.Unlock()
		slot.commandMu.Unlock()
		e.replyErr(s, id, "conflict", "terminal session is no longer active")
		return
	}
	s.terminal = nil
	s.terminalMu.Unlock()
	_ = slot.controller.Close()
	slot.commandMu.Unlock()
	e.audit("terminal_close", map[string]any{"device_id": s.deviceID, "operation_id": p.OperationID, "pane_id": slot.paneID})
	e.reply(s, id, map[string]any{"operation_id": p.OperationID, "terminal_id": slot.id, "closed": true})
}

func (e *Engine) runTerminalCommand(s *sess, id, operationID, terminalID string, sequence uint64, run func(runtime.TerminalController) error, auditOp string, auditFields map[string]any) {
	s.terminalMu.Lock()
	slot := s.terminal
	if slot == nil || slot.id != terminalID {
		s.terminalMu.Unlock()
		e.replyErr(s, id, "conflict", "terminal session is no longer active")
		return
	}
	s.terminalMu.Unlock()
	slot.commandMu.Lock()
	defer slot.commandMu.Unlock()
	s.terminalMu.Lock()
	if s.terminal != slot {
		s.terminalMu.Unlock()
		e.replyErr(s, id, "conflict", "terminal session is no longer active")
		return
	}
	if sequence < slot.nextCommand {
		accepted := slot.nextCommand - 1
		s.terminalMu.Unlock()
		e.reply(s, id, map[string]any{"operation_id": operationID, "terminal_id": terminalID, "accepted_seq": accepted, "duplicate": true})
		return
	}
	if sequence != slot.nextCommand {
		s.terminalMu.Unlock()
		e.replyErr(s, id, "conflict", "terminal command sequence has a gap")
		return
	}
	s.terminalMu.Unlock()
	err := run(slot.controller)
	s.terminalMu.Lock()
	active := s.terminal == slot
	if err == nil && active {
		slot.nextCommand++
	}
	s.terminalMu.Unlock()
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	if !active {
		e.replyErr(s, id, "conflict", "terminal session is no longer active")
		return
	}
	fields := map[string]any{"device_id": s.deviceID, "operation_id": operationID, "pane_id": slot.paneID, "seq": sequence}
	for key, value := range auditFields {
		fields[key] = value
	}
	e.audit(auditOp, fields)
	e.reply(s, id, map[string]any{"operation_id": operationID, "terminal_id": terminalID, "accepted_seq": sequence, "duplicate": false})
}

func (e *Engine) forwardTerminal(s *sess, slot *terminalSlot) {
	for event := range slot.controller.Events() {
		if event.Frame != nil {
			if len(event.Frame.Data) > maxTerminalFrameBytes || !e.sendTerminalFrame(s, slot, *event.Frame) {
				e.closeTerminalSlot(s, slot, "terminal frame could not be delivered", true)
				return
			}
			continue
		}
		if event.Closed != nil {
			reason := event.Closed.Reason
			if reason == "" {
				reason = "terminal bridge closed"
			}
			e.closeTerminalSlot(s, slot, reason, true)
			return
		}
	}
	e.closeTerminalSlot(s, slot, "terminal bridge closed", true)
}

func (e *Engine) sendTerminalFrame(s *sess, slot *terminalSlot, frame runtime.TerminalFrame) bool {
	if frame.Sequence == 0 || !runtime.ValidTerminalSize(frame.Width, frame.Height) {
		return false
	}
	parts := 1
	if len(frame.Data) > 0 {
		parts = (len(frame.Data) + terminalFrameChunk - 1) / terminalFrameChunk
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if !e.terminalSlotActive(s, slot) {
		return false
	}
	for index := 0; index < parts; index++ {
		start := index * terminalFrameChunk
		end := start + terminalFrameChunk
		if end > len(frame.Data) {
			end = len(frame.Data)
		}
		body, err := json.Marshal(map[string]any{
			"v": 1, "op": "TerminalFrame", "params": map[string]any{
				"terminal_id": slot.id, "seq": fmt.Sprintf("%d", frame.Sequence),
				"width": frame.Width, "height": frame.Height, "full": frame.Full,
				"index": index, "count": parts, "data": base64.StdEncoding.EncodeToString(frame.Data[start:end]),
			},
		})
		if err != nil || len(body) > aead.MaxPlaintext {
			return false
		}
		e.mu.Lock()
		active := s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
		e.mu.Unlock()
		if !active {
			return false
		}
		payload, err := aead.Seal(s.s2c, s.routeID, body)
		if err != nil || e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}) != nil {
			return false
		}
	}
	return true
}

func (e *Engine) closeTerminalSlot(s *sess, slot *terminalSlot, reason string, notify bool) {
	s.terminalMu.Lock()
	if s.terminal != slot {
		s.terminalMu.Unlock()
		return
	}
	s.terminal = nil
	s.terminalMu.Unlock()
	slot.commandMu.Lock()
	_ = slot.controller.Close()
	slot.commandMu.Unlock()
	if notify {
		e.sendTerminalClosed(s, slot.id, reason)
	}
}

func (e *Engine) sendTerminalClosed(s *sess, terminalID, reason string) {
	if len(reason) > 512 {
		reason = reason[:512]
	}
	body, err := json.Marshal(map[string]any{
		"v": 1, "op": "TerminalClosed", "params": map[string]any{"terminal_id": terminalID, "reason": reason},
	})
	if err != nil || len(body) > aead.MaxPlaintext {
		return
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	e.mu.Lock()
	active := s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
	e.mu.Unlock()
	if !active {
		return
	}
	payload, err := aead.Seal(s.s2c, s.routeID, body)
	if err == nil {
		_ = e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload})
	}
}

func (e *Engine) terminalSlotActive(s *sess, slot *terminalSlot) bool {
	s.terminalMu.Lock()
	active := s.terminal == slot
	s.terminalMu.Unlock()
	return active
}

func closeSessionTerminal(s *sess) {
	if s == nil {
		return
	}
	s.terminalMu.Lock()
	slot := s.terminal
	s.terminal = nil
	s.terminalMu.Unlock()
	if slot != nil {
		slot.commandMu.Lock()
		_ = slot.controller.Close()
		slot.commandMu.Unlock()
	}
}

func newTerminalID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "term_" + hex.EncodeToString(raw[:]), nil
}
