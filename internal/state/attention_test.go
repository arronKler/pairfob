package state

import (
	"os"
	"path/filepath"
	"testing"
)

func attentionRow(id, pane string, created int64) AttentionEvent {
	return AttentionEvent{
		ID: id, PaneID: pane, TerminalID: "term", InstanceID: "instance", CreatedAt: created,
		Deliveries: map[string]AttentionDelivery{
			"dev_12345678": {Count: 2, LastAt: created + 10},
		},
	}
}

func TestAttentionLedgerRoundTrip(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	open := attentionRow("att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "w1:p1", 100)
	resolved := attentionRow("att_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "w1:p2", 200)
	resolved.Session = "alpha"
	resolved.CreatedAtNS = 200_000_000_007
	resolved.ResolvedAt = 300
	if err := store.SaveAttention([]AttentionEvent{resolved, open}); err != nil {
		t.Fatal(err)
	}
	rows, err := store.LoadAttention()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != open.ID || rows[1].ID != resolved.ID {
		t.Fatalf("rows=%+v", rows)
	}
	if rows[1].Session != "alpha" || rows[1].ResolvedAt != 300 || rows[1].CreatedAtNS != resolved.CreatedAtNS || rows[1].Deliveries["dev_12345678"].LastAt != 210 {
		t.Fatalf("resolved row=%+v", rows[1])
	}
	info, err := os.Stat(filepath.Join(store.Dir, "attention.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("attention mode: info=%v err=%v", info, err)
	}
}

func TestAttentionLedgerValidationFailsClosed(t *testing.T) {
	valid := attentionRow("att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "w1:p1", 100)
	tests := []struct {
		name string
		edit func(*AttentionEvent)
	}{
		{name: "duplicate id", edit: func(*AttentionEvent) {}},
		{name: "bad id", edit: func(event *AttentionEvent) { event.ID = "att_x" }},
		{name: "empty pane", edit: func(event *AttentionEvent) { event.PaneID = "" }},
		{name: "control in pane", edit: func(event *AttentionEvent) { event.PaneID = "w1:\x00p1" }},
		{name: "bad session", edit: func(event *AttentionEvent) { event.Session = "a/b" }},
		{name: "missing created", edit: func(event *AttentionEvent) { event.CreatedAt = 0 }},
		{name: "inconsistent episode order", edit: func(event *AttentionEvent) { event.CreatedAtNS = 99_999_999_999 }},
		{name: "resolved before created", edit: func(event *AttentionEvent) { event.ResolvedAt = 50 }},
		{name: "bad device", edit: func(event *AttentionEvent) { event.Deliveries["device"] = AttentionDelivery{} }},
		{name: "too many deliveries", edit: func(event *AttentionEvent) {
			event.Deliveries["dev_12345678"] = AttentionDelivery{Count: 4, LastAt: 110}
		}},
		{name: "missing last delivery time", edit: func(event *AttentionEvent) {
			event.Deliveries["dev_12345678"] = AttentionDelivery{Count: 1}
		}},
		{name: "retracted without delivery", edit: func(event *AttentionEvent) {
			event.Deliveries["dev_12345678"] = AttentionDelivery{RetractedAt: 120}
		}},
		{name: "retract without attempt", edit: func(event *AttentionEvent) {
			event.Deliveries["dev_12345678"] = AttentionDelivery{Count: 1, LastAt: 110, RetractCount: 1}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			row := attentionRow(valid.ID, valid.PaneID, valid.CreatedAt)
			row.Deliveries = map[string]AttentionDelivery{"dev_12345678": {Count: 2, LastAt: 110}}
			test.edit(&row)
			rows := []AttentionEvent{row}
			if test.name == "duplicate id" {
				rows = append(rows, row)
			}
			if err := validateAttention(rows); err == nil {
				t.Fatal("invalid ledger was accepted")
			}
		})
	}
	if err := validateAttention([]AttentionEvent{valid}); err != nil {
		t.Fatalf("valid ledger rejected: %v", err)
	}
}
