// Package remotedesktop owns a locally approved desktop media stream.
// Only the daemon authenticates devices and binds the stream to a direct route.
package remotedesktop

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

type Policy struct {
	Supported, View, Control bool
	Display, GrantID         string
}

type Request struct {
	OperationID string `json:"operation_id"`
	SDP         string `json:"sdp"`
	Control     bool   `json:"control"`
	Audio       bool   `json:"audio"`
	Quality     string `json:"quality"`
}

type Result struct {
	SDP     string `json:"sdp"`
	Display string `json:"display"`
	Control bool   `json:"control"`
	Audio   bool   `json:"audio"`
}

type Stream interface {
	Input(Event) error
	Done() <-chan struct{}
}

type Host interface {
	Policy() Policy
	Open(context.Context, string, Request) (Stream, Result, error)
}

type Event struct {
	Kind      string   `json:"kind"`
	X         *float64 `json:"x,omitempty"`
	Y         *float64 `json:"y,omitempty"`
	Button    string   `json:"button,omitempty"`
	DX        int      `json:"dx,omitempty"`
	DY        int      `json:"dy,omitempty"`
	Code      string   `json:"code,omitempty"`
	Modifiers int      `json:"modifiers,omitempty"`
	Text      string   `json:"text,omitempty"`
}

func (p Event) Valid() bool {
	point := p.X != nil && p.Y != nil && !math.IsNaN(*p.X) && !math.IsNaN(*p.Y) && *p.X >= 0 && *p.X <= 1 && *p.Y >= 0 && *p.Y <= 1
	switch p.Kind {
	case "move":
		return point
	case "down", "up":
		return point && (p.Button == "left" || p.Button == "right" || p.Button == "middle")
	case "scroll":
		return point && p.DX >= -1500 && p.DX <= 1500 && p.DY >= -1500 && p.DY <= 1500
	case "text":
		return len(p.Text) > 0 && len(p.Text) <= 4096 && utf8.ValidString(p.Text)
	case "key":
		return len(p.Code) > 0 && len(p.Code) <= 32 && p.Modifiers >= 0 && p.Modifiers <= 15
	case "release":
		return true
	}
	return false
}

var ErrUnavailable = errors.New("remote desktop is disabled or unavailable")

// IsKnownReason reports whether code is a recognized structured desktop stop/failure reason.
func IsKnownReason(code string) bool {
	switch code {
	case "locked", "sleeping", "perm_screen", "perm_accessibility", "stopped_on_host", "display_unavailable":
		return true
	default:
		return false
	}
}

// ParseReasonCode extracts a valid [reason:<code>] prefix if present.
func ParseReasonCode(msg string) string {
	rest, ok := strings.CutPrefix(strings.TrimSpace(msg), "[reason:")
	if !ok {
		return ""
	}
	end := strings.IndexByte(rest, ']')
	if end <= 0 {
		return ""
	}
	code := rest[:end]
	if IsKnownReason(code) {
		return code
	}
	return ""
}

// ClassifyReason maps a structured prefix or known host error message to a reason code.
func ClassifyReason(msg string) string {
	if code := ParseReasonCode(msg); code != "" {
		return code
	}
	lower := strings.ToLower(msg)
	switch {
	case lower == "":
		return ""
	case strings.Contains(lower, "locked") || strings.Contains(lower, "unlock") || strings.Contains(lower, "resign"):
		return "locked"
	case strings.Contains(lower, "sleep") || strings.Contains(lower, "asleep") || strings.Contains(lower, "unable to wake") || strings.Contains(lower, "inactive"):
		return "sleeping"
	case strings.Contains(lower, "screen recording") || strings.Contains(lower, "screen capture") || strings.Contains(lower, "tcc"):
		return "perm_screen"
	case strings.Contains(lower, "accessibility"):
		return "perm_accessibility"
	case strings.Contains(lower, "stopped on mac") || strings.Contains(lower, "user stopped"):
		return "stopped_on_host"
	case strings.Contains(lower, "display") && (strings.Contains(lower, "unavailable") || strings.Contains(lower, "changed") || strings.Contains(lower, "no longer active") || strings.Contains(lower, "not found")):
		return "display_unavailable"
	default:
		return ""
	}
}

// NormalizeReasonError attaches a [reason:<code>] prefix when err or fallbackCode identifies a known cause.
func NormalizeReasonError(err error, fallbackCode string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if ParseReasonCode(msg) != "" {
		return err
	}
	code := ClassifyReason(msg)
	if code == "" && IsKnownReason(fallbackCode) {
		code = fallbackCode
	}
	if code == "" {
		return err
	}
	return fmt.Errorf("[reason:%s] %w", code, err)
}
