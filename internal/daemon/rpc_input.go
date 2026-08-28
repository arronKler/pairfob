package daemon

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/blake2s"

	"pairfob/internal/runtime"
)

// guardedPaneReadLines must match the PWA guarded submit read. Herdr protocol
// 19 treats zero as a zero-row snapshot rather than an unbounded visible read.
const guardedPaneReadLines = 80

func (e *Engine) rpcSendText(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		PaneID      string  `json:"pane_id"`
		Text        *string `json:"text"`
		Submit      bool    `json:"submit"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || p.Text == nil || !utf8.ValidString(*p.Text) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	if len([]byte(*p.Text)) > maxTextBytes {
		e.replyErr(s, id, "too_large", "text exceeds 32 KiB")
		return
	}
	operationID, ok := mutationOperationID(p.OperationID, id, true)
	if !ok {
		e.replyErr(s, id, "invalid_argument", "invalid operation_id")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	intent := struct {
		PaneID string `json:"pane_id"`
		Text   string `json:"text"`
		Submit bool   `json:"submit"`
	}{PaneID: p.PaneID, Text: *p.Text, Submit: p.Submit}
	sessionRef := runtimeSession(p.Session)
	receipt, err := e.executeTrackedMutation(ctx, s.deviceID, sessionRef, operationID, intent, func() (runtime.Receipt, error) {
		receipt, phaseErr := e.RT.Execute(ctx, sessionRef, derivedOperationID(operationID, "text"), runtime.SendTextCommand{PaneID: p.PaneID, Text: *p.Text})
		if phaseErr != nil {
			return receipt, phaseErr
		}
		if !p.Submit {
			return receipt, nil
		}
		submitReceipt, submitErr := e.RT.Execute(ctx, sessionRef, derivedOperationID(operationID, "submit"), runtime.SendKeysCommand{PaneID: p.PaneID, Keys: []string{"enter"}})
		if submitErr != nil {
			if fault, faultOK := runtime.AsFault(submitErr); faultOK && fault.Outcome == runtime.OutcomeNotApplied {
				fault.Outcome = runtime.OutcomePartial
			}
			return submitReceipt, submitErr
		}
		return submitReceipt, nil
	})
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	e.audit("send_text", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID, "bytes": len([]byte(*p.Text)), "submit": p.Submit})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcPromptAgent(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		PaneID      string  `json:"pane_id"`
		Text        string  `json:"text"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || !validID(p.PaneID) || p.Text == "" || !utf8.ValidString(p.Text) {
		e.replyErr(s, id, "invalid_argument", "invalid agent prompt params")
		return
	}
	if len([]byte(p.Text)) > maxTextBytes {
		e.replyErr(s, id, "too_large", "agent prompt exceeds 32 KiB")
		return
	}
	pane, findErr := e.findPane(p.Session, p.PaneID)
	if findErr != nil {
		e.replyRuntimeErr(s, id, findErr, "pane_not_found")
		return
	}
	if pane == nil || pane.Agent == "" {
		e.replyErr(s, id, "agent_not_found", "pane does not currently host an agent")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.PromptAgentCommand{Target: p.PaneID, Text: p.Text}, "agent_not_found")
	if !ok {
		return
	}
	e.audit("prompt_agent", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID, "bytes": len([]byte(p.Text)), "outcome": receipt.Outcome})
	e.reply(s, id, map[string]any{"pane_id": p.PaneID, "agent_status": "working", "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) dispatchSendKeys(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session        *string  `json:"session"`
		OperationID    string   `json:"operation_id"`
		PaneID         string   `json:"pane_id"`
		Keys           []string `json:"keys"`
		Intent         string   `json:"intent"`
		ExpectedPrompt string   `json:"expected_prompt"`
		ExpectedSig    string   `json:"expected_signature"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || len(p.Keys) == 0 || len(p.Keys) > maxKeys {
		e.replyErr(s, id, "too_large", "invalid key request")
		return
	}
	if p.Intent != "pad" && p.Intent != "dialog" && p.Intent != "submit" {
		e.replyErr(s, id, "invalid_key", "invalid intent")
		return
	}
	mapped := make([]string, len(p.Keys))
	for i, key := range p.Keys {
		canon, ok := runtime.CanonicalSendKey(key)
		if !ok {
			e.replyErr(s, id, "invalid_key", key)
			return
		}
		mapped[i] = canon
	}
	p.Keys = mapped
	if (p.Intent == "dialog" || p.Intent == "submit") && p.ExpectedPrompt == "" {
		e.replyErr(s, id, "stale_prompt", "expected_prompt is required")
		return
	}
	if utf8.RuneCountInString(p.ExpectedPrompt) > maxPromptBytes || (p.ExpectedSig != "" && len(p.ExpectedSig) != 64) {
		e.replyErr(s, id, "too_large", "guard exceeds limit")
		return
	}
	if p.ExpectedPrompt != "" || p.ExpectedSig != "" {
		view, err := e.observe(p.Session, runtime.PaneReadQuery{
			PaneID: p.PaneID, Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: guardedPaneReadLines,
		})
		if err != nil {
			e.replyRuntimeErr(s, id, err, "pane_not_found")
			return
		}
		read, ok := view.(runtime.PaneReadView)
		if !ok {
			e.replyErr(s, id, "internal", "runtime returned an invalid pane view")
			return
		}
		text := read.Text
		if p.ExpectedPrompt != "" && !strings.Contains(text, p.ExpectedPrompt) {
			e.replyErr(s, id, "stale_prompt", "expected prompt is no longer visible")
			return
		}
		if p.ExpectedSig != "" {
			sum := blake2s.Sum256([]byte(text))
			got, err := hex.DecodeString(p.ExpectedSig)
			if err != nil || len(got) != len(sum) || subtle.ConstantTimeCompare(sum[:], got) != 1 {
				e.replyErr(s, id, "stale_prompt", "signature mismatch")
				return
			}
		}
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.SendKeysCommand{PaneID: p.PaneID, Keys: p.Keys}, "pane_not_found")
	if !ok {
		return
	}
	e.audit("send_keys", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID, "keys": len(p.Keys), "intent": p.Intent})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}
