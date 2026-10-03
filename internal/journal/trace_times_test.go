package journal

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRecordTimeParsesTranscriptTimestamps(t *testing.T) {
	future := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	for raw, want := range map[string]int64{
		`"2026-10-03T02:06:41.949Z"`:       1790993201949,
		`"2026-10-03T02:06:41Z"`:           1790993201000,
		`"2026-10-03T10:06:41.5+08:00"`:    1790993201500,
		`"2026-10-03T02:06:41.123456789Z"`: 1790993201123,
		`1790993201`:                       1790993201000,
		`1790993201949`:                    1790993201949,
		`1790993201.25`:                    1790993201250,
		`"2026-10-03 02:06:41"`:            0,
		`"1790993201"`:                     0,
		`"yesterday"`:                      0,
		`"1999-12-31T23:59:59Z"`:           0,
		`"` + future + `"`:                 0,
		`946684799`:                        0,
		`-5`:                               0,
		`1e300`:                            0,
		`null`:                             0,
		`true`:                             0,
		`{}`:                               0,
		``:                                 0,
	} {
		if got := recordTime(json.RawMessage(raw)); got != want {
			t.Errorf("recordTime(%s)=%d, want %d", raw, got, want)
		}
	}
}

// requireSameShape checks that times never move a page boundary, cursor or
// detail ref, and returns the at values of the timed view.
func requireSameShape(t *testing.T, plain, timed TraceSummaryPage) []int64 {
	t.Helper()
	if encoded, _ := json.Marshal(plain); strings.Contains(string(encoded), `"at"`) {
		t.Fatalf("at without opt-in: %s", encoded)
	}
	if len(plain.Items) != len(timed.Items) || (plain.NextCursor == nil) != (timed.NextCursor == nil) || (plain.NextCursor != nil && *plain.NextCursor != *timed.NextCursor) {
		t.Fatalf("pages differ: plain=%+v timed=%+v", plain, timed)
	}
	ats := make([]int64, 0, len(timed.Items))
	for i, item := range timed.Items {
		withoutAt := item
		withoutAt.At = 0
		if withoutAt != plain.Items[i] {
			t.Fatalf("item %d differs beyond at: %+v vs %+v", i, item, plain.Items[i])
		}
		ats = append(ats, item.At)
	}
	return ats
}

func readTimedSummary(t *testing.T, reader *Reader, ref Ref, limit int, options TraceOptions) []int64 {
	t.Helper()
	plain, err := reader.ReadTraceSummaryWith(ref, nil, limit, options)
	if err != nil {
		t.Fatal(err)
	}
	options.Times = true
	timed, err := reader.ReadTraceSummaryWith(ref, nil, limit, options)
	if err != nil {
		t.Fatal(err)
	}
	return requireSameShape(t, plain, timed)
}

func joinTimes(ats []int64) string {
	parts := make([]string, 0, len(ats))
	for _, at := range ats {
		parts = append(parts, strconv.FormatInt(at, 10))
	}
	return strings.Join(parts, ",")
}

func TestClaudeTraceSummaryTimesAreOptIn(t *testing.T) {
	root := t.TempDir()
	id := "12345678-abcd-4321-abcd-1234567890ab"
	at := func(line map[string]any, stamp string) map[string]any {
		line["timestamp"] = stamp
		return line
	}
	writeLines(t, filepath.Join(root, "projects", "-tmp-pairfob", id+".jsonl"),
		at(claudeUser("fix it", nil), "2026-10-03T02:06:41.949Z"),
		at(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "thinking", "thinking": "look"},
			{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "ls"}},
		}}}, "2026-10-03T02:06:43.000Z"),
		at(claudeUser([]map[string]any{{"type": "tool_result", "tool_use_id": "toolu_1", "content": "a.go"}}, nil), "2026-10-03T02:07:00.000Z"),
		map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "no stamp"}}}},
		at(map[string]any{"type": "system", "subtype": "compact_boundary"}, "2026-10-03T02:08:00.000Z"),
		at(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "bad stamp"}}}}, "not a time"),
	)
	reader, ref := &Reader{ClaudeRoot: root}, Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	// The tool keeps its call's time, not its output's.
	if got := joinTimes(readTimedSummary(t, reader, ref, 50, TraceOptions{Markers: true})); got != "1790993201949,1790993203000,1790993203000,0,1790993280000,0" {
		t.Fatalf("times=%s", got)
	}
	if got := joinTimes(readTimedSummary(t, reader, ref, 3, TraceOptions{})); got != "1790993203000,0,0" {
		t.Fatalf("paged times=%s", got)
	}
	full, err := reader.ReadTraceWith(ref, nil, 50, TraceOptions{Times: true})
	if encoded, _ := json.Marshal(full); err != nil || strings.Contains(string(encoded), `"at"`) {
		t.Fatalf("full trace carries at: %s err=%v", encoded, err)
	}
}

func TestCodexTraceSummaryTimesCoverMarkers(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		map[string]any{"timestamp": "2026-09-29T10:40:18.042Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "go"}},
		}},
		map[string]any{"timestamp": "2026-09-29T10:42:00.639Z", "type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": `{"cmd":"ls"}`,
		}},
		map[string]any{"timestamp": "2026-09-29T10:42:00.949Z", "type": "response_item", "payload": map[string]any{
			"type": "function_call_output", "call_id": "c1", "output": "Process exited with code 0\nOutput:\nok",
		}},
		map[string]any{"timestamp": "2026-09-29T10:43:00.000Z", "type": "event_msg", "payload": map[string]any{"type": "turn_aborted", "reason": "interrupted"}},
		map[string]any{"timestamp": "2026-09-29T10:44:00.000Z", "type": "compacted", "payload": map[string]any{"message": ""}},
	)
	reader, ref := &Reader{CodexRoot: root}, Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	if got := joinTimes(readTimedSummary(t, reader, ref, 50, TraceOptions{Markers: true, Labels: true})); got != "1790678418042,1790678520639,1790678580000,1790678640000" {
		t.Fatalf("times=%s", got)
	}
}

func TestGrokTraceSummaryTimesUseFirstChunkAndAgentClock(t *testing.T) {
	root := t.TempDir()
	id := "grok_session_1"
	update := func(seconds any, agentMs any, value map[string]any) map[string]any {
		params := map[string]any{"update": value}
		if agentMs != nil {
			params["_meta"] = map[string]any{"agentTimestampMs": agentMs}
		}
		return map[string]any{"timestamp": seconds, "method": "session/update", "params": params}
	}
	chunk := func(kind, text string) map[string]any {
		return map[string]any{"sessionUpdate": kind, "messageId": "m1", "content": map[string]any{"type": "text", "text": text}}
	}
	writeLines(t, filepath.Join(root, "sessions", "%2Ftmp", id, "updates.jsonl"),
		update(1786641140, 1786641137788, chunk("user_message_chunk", "hi")),
		update(1786641141, nil, chunk("agent_message_chunk", "hel")),
		update(1786641142, 1786641142246, chunk("agent_message_chunk", "lo")),
		update("garbage", nil, chunk("agent_thought_chunk", "hmm")),
	)
	reader, ref := &Reader{GrokRoot: root}, Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: id}
	if got := joinTimes(readTimedSummary(t, reader, ref, 50, TraceOptions{})); got != "1786641137788,1786641141000,0" {
		t.Fatalf("times=%s", got)
	}
}

func TestPiTraceSummaryTimesUseEntryTimestamp(t *testing.T) {
	stamped := func(line map[string]any, stamp string) map[string]any {
		line["timestamp"] = stamp
		return line
	}
	reader, ref, _ := piFixture(t,
		stamped(msg("user0001", nil, "user", "go"), "2026-08-07T14:35:18.636Z"),
		stamped(msg("asst0001", "user0001", "assistant", []any{
			map[string]any{"type": "text", "text": "ok"},
			map[string]any{"type": "toolCall", "id": "call-1", "name": "bash", "arguments": map[string]any{"command": "ls"}},
		}), "2026-08-07T14:35:20.000Z"),
		stamped(map[string]any{"type": "message", "id": "tool0001", "parentId": "asst0001", "message": map[string]any{"role": "toolResult", "toolCallId": "call-1", "toolName": "bash", "content": "a.go"}}, "2026-08-07T14:36:00.000Z"),
		msg("asst0002", "tool0001", "assistant", []any{map[string]any{"type": "text", "text": "done"}}),
	)
	if got := joinTimes(readTimedSummary(t, reader, ref, 50, TraceOptions{})); got != "1786113318636,1786113320000,1786113320000,0" {
		t.Fatalf("times=%s", got)
	}
}

func TestSummaryExtrasDropLabelsBeforeTimes(t *testing.T) {
	const at = 1790993201949
	items := []TraceSummaryItem{
		{Type: "tool", Name: "Read", DetailRef: "r1", At: at},
		{Type: "assistant", At: at},
		{Type: "tool", Name: "Read", DetailRef: "r2", At: at},
	}
	// Without labels the page is 5 bytes over budget: one dropped time fits it.
	total := 0
	for _, item := range items {
		total += summaryItemSize(item)
	}
	items[1].Text = strings.Repeat("x", maxTraceItemsBytes-total+5)
	items[0].Label, items[2].Label = strings.Repeat("a", 150), strings.Repeat("b", 150)
	fitSummaryExtras(items)
	if items[0].Label != "" || items[2].Label != "" || items[0].At != 0 || items[1].At != at || items[2].At != at {
		t.Fatalf("labels=%q,%q times=%d,%d,%d", items[0].Label, items[2].Label, items[0].At, items[1].At, items[2].At)
	}
	total = 0
	for _, item := range items {
		total += summaryItemSize(item)
	}
	if total > maxTraceItemsBytes {
		t.Fatalf("summary bytes=%d over budget", total)
	}
}
