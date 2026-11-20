// Package remotedesktop owns a locally approved desktop media stream.
// Only the daemon authenticates devices and binds the stream to a direct route.
package remotedesktop

import (
	"context"
	"errors"
	"math"
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
