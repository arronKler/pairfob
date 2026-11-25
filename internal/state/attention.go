package state

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"unicode"
	"unicode/utf8"
)

// AttentionDelivery records what one device was told about one pane episode.
// Count and LastAt drive the bounded 5/15-minute escalation; RetractCount and
// RetractAt drive closing the notice once the pane stops needing the reader.
type AttentionDelivery struct {
	Count        int   `json:"count"`
	LastAt       int64 `json:"last_at,omitempty"`
	RetractCount int   `json:"retract_count,omitempty"`
	RetractAt    int64 `json:"retract_at,omitempty"`
	RetractedAt  int64 `json:"retracted_at,omitempty"`
}

// AttentionEvent is one pane episode that needed the reader. An unresolved
// event is the authority for that pane's needs-you notice; a resolved event
// stays only until every device that saw it has been sent a resolution update.
type AttentionEvent struct {
	ID         string `json:"id"`
	Session    string `json:"session,omitempty"`
	PaneID     string `json:"pane_id"`
	TerminalID string `json:"terminal_id,omitempty"`
	InstanceID string `json:"instance_id,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	// CreatedAtNS orders episodes that start in the same second. Older ledgers
	// omit it and use CreatedAt at second precision.
	CreatedAtNS int64                        `json:"created_at_ns,omitempty"`
	ResolvedAt  int64                        `json:"resolved_at,omitempty"`
	Deliveries  map[string]AttentionDelivery `json:"deliveries,omitempty"`
}

var (
	attentionIDPattern   = regexp.MustCompile(`^att_[0-9a-f]{32}$`)
	attentionSessionName = regexp.MustCompile(`^[A-Za-z0-9._-]{0,128}$`)
)

func validAttentionText(value string, max int) bool {
	if len(value) > max || !utf8.ValidString(value) {
		return false
	}
	return !containsControl(value)
}

func containsControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func (s *Store) LoadAttention() ([]AttentionEvent, error) {
	var events []AttentionEvent
	err := readJSON(s.path("attention.json"), &events)
	if errors.Is(err, os.ErrNotExist) {
		return []AttentionEvent{}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := validateAttention(events); err != nil {
		return nil, err
	}
	return events, nil
}

// SaveAttention writes the ledger in a stable order so identical state does
// not churn the file.
func (s *Store) SaveAttention(events []AttentionEvent) error {
	if err := validateAttention(events); err != nil {
		return err
	}
	rows := append([]AttentionEvent(nil), events...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return atomicJSON(s.path("attention.json"), rows)
}

func validateAttention(events []AttentionEvent) error {
	if len(events) > 512 {
		return errors.New("attention.json exceeds 512 rows")
	}
	seen := make(map[string]struct{}, len(events))
	for _, event := range events {
		if !attentionIDPattern.MatchString(event.ID) {
			return fmt.Errorf("attention.json contains invalid event id %q", event.ID)
		}
		if _, exists := seen[event.ID]; exists {
			return fmt.Errorf("attention.json contains duplicate event id %q", event.ID)
		}
		seen[event.ID] = struct{}{}
		if !attentionSessionName.MatchString(event.Session) {
			return fmt.Errorf("attention.json contains invalid session for %q", event.ID)
		}
		if !validAttentionText(event.PaneID, 256) || event.PaneID == "" {
			return fmt.Errorf("attention.json contains invalid pane_id for %q", event.ID)
		}
		if !validAttentionText(event.TerminalID, 256) || !validAttentionText(event.InstanceID, 256) {
			return fmt.Errorf("attention.json contains invalid occupant for %q", event.ID)
		}
		if event.CreatedAt <= 0 || (event.ResolvedAt != 0 && event.ResolvedAt < event.CreatedAt) {
			return fmt.Errorf("attention.json contains invalid timestamps for %q", event.ID)
		}
		if event.CreatedAtNS != 0 && event.CreatedAtNS/1_000_000_000 != event.CreatedAt {
			return fmt.Errorf("attention.json contains invalid episode order for %q", event.ID)
		}
		if len(event.Deliveries) > 1000 {
			return fmt.Errorf("attention.json contains too many deliveries for %q", event.ID)
		}
		for deviceID, delivery := range event.Deliveries {
			if !deviceIDPattern.MatchString(deviceID) {
				return fmt.Errorf("attention.json contains invalid device for %q", event.ID)
			}
			if delivery.Count < 0 || delivery.Count > 3 || delivery.RetractCount < 0 || delivery.RetractCount > 3 {
				return fmt.Errorf("attention.json contains invalid delivery count for %q", event.ID)
			}
			if (delivery.Count > 0 && delivery.LastAt <= 0) || (delivery.RetractCount > 0 && delivery.RetractAt <= 0) {
				return fmt.Errorf("attention.json contains invalid delivery time for %q", event.ID)
			}
			if delivery.Count == 0 && delivery.RetractedAt != 0 {
				return fmt.Errorf("attention.json retracted an undelivered notice for %q", event.ID)
			}
		}
	}
	return nil
}
