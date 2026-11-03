package journal

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func jsonLine(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func claudeImageBlock(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{"type": "image", "source": map[string]any{
		"type": "base64", "media_type": "image/png", "data": strings.Repeat("A", 1024),
	}}
}

func TestTopLevelJSONTypeReadsOnlyTheRecordType(t *testing.T) {
	cases := []struct {
		name string
		line string
		kind string
		ok   bool
	}{
		{"plain", `{"type":"user","message":{"role":"user"}}`, "user", true},
		{"whitespace", " \t{ \"type\" :\n \"assistant\" , \"x\":1 }", "assistant", true},
		{"nested type wins nothing", `{"message":{"type":"user"},"type":"assistant"}`, "assistant", true},
		{"missing type", `{"message":{"type":"user"}}`, "", false},
		{"duplicate type", `{"type":"user","type":"assistant"}`, "", false},
		{"escaped type", `{"type":"us` + string(rune(0x5c)) + `u0065r"}`, "", false},
		{"not an object", `["user"]`, "", false},
		{"malformed", `{"type":"user"`, "", false},
		{"type is not a string", `{"type":1}`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, ok := topLevelJSONType([]byte(tc.line))
			if kind != tc.kind || ok != tc.ok {
				t.Fatalf("kind=%q ok=%v, want %q %v", kind, ok, tc.kind, tc.ok)
			}
		})
	}
}

func TestClaudeImageOnlyUserRecord(t *testing.T) {
	image := claudeImageBlock(t)
	imageRecord := func(content []any) []byte {
		return jsonLine(t, map[string]any{"type": "user", "message": map[string]any{
			"role": "user", "content": content,
		}})
	}
	toolResult := func(content any) map[string]any {
		return map[string]any{"type": "tool_result", "tool_use_id": "call_1", "content": content}
	}
	cases := []struct {
		name string
		line []byte
		want bool
	}{
		{"one image", imageRecord([]any{toolResult([]any{image})}), true},
		{"two images", imageRecord([]any{toolResult([]any{image, claudeImageBlock(t)})}), true},
		{"image and text", imageRecord([]any{toolResult([]any{image, map[string]any{"type": "text", "text": "caption"}})}), false},
		{"text result", imageRecord([]any{toolResult("plain")}), false},
		{"nested object content", imageRecord([]any{toolResult(map[string]any{"type": "image"})}), false},
		{"image beside a tool result", imageRecord([]any{toolResult([]any{image}), map[string]any{"type": "text", "text": "why"}}), false},
		{"image block with text", imageRecord([]any{toolResult([]any{
			map[string]any{"type": "image", "text": "", "source": map[string]any{"data": "A"}},
		})}), false},
		{"assistant record", jsonLine(t, map[string]any{"type": "assistant", "message": map[string]any{
			"role": "assistant", "content": []any{toolResult([]any{image})},
		}}), false},
		{"user prompt", imageRecord([]any{map[string]any{"type": "text", "text": "look"}}), false},
		{"malformed", []byte(`{"type":"user","message":{"role":"user","content":[`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := claudeImageOnlyUserRecord(tc.line); got != tc.want {
				t.Fatalf("got %v, want %v for %s", got, tc.want, tc.line)
			}
		})
	}
}

func TestClaudeImageToolResultIsNotDecodedIntoTheChat(t *testing.T) {
	image := claudeImageBlock(t)
	image["source"].(map[string]any)["data"] = strings.Repeat("A", claudeImagePrefilterMin)
	rawImage := jsonLine(t, image)
	// Claude Code writes the block marker before the payload, as below. Encoding
	// a map would sort "content" first and bury the marker.
	line := []byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[` + string(rawImage) + `]}]}}`)
	if len(line) < claudeImagePrefilterMin {
		t.Fatalf("fixture is %d bytes, want at least %d", len(line), claudeImagePrefilterMin)
	}
	if !bytes.Contains(line[:claudeImagePrefilterHint], []byte(`"tool_result"`)) {
		t.Fatal("fixture does not reach the prefilter's marker hint")
	}
	if events := parseClaudeTrace(line); len(events) != 0 {
		t.Fatalf("image-only result produced %d events", len(events))
	}

	// The same record with a caption keeps the text and drops the payload.
	line = []byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[` +
		string(rawImage) + `,{"type":"text","text":"the screenshot shows the list"}]}]}}`)
	events := parseClaudeTrace(line)
	if len(events) != 1 || events[0].Output != "the screenshot shows the list" || events[0].outputOnly != true {
		t.Fatalf("image result with caption=%+v", events)
	}
	if bytes.Contains([]byte(events[0].Output), []byte("AAAA")) {
		t.Fatal("caption event still carries the image payload")
	}
}

func TestClaudeRecordScanMatchesFullDecode(t *testing.T) {
	imageJSON := string(jsonLine(t, map[string]any{"type": "image", "source": map[string]any{
		"type": "base64", "media_type": "image/png", "data": strings.Repeat("A", claudeImagePrefilterMin),
	}}))
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"hello"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"thinking","thinking":"hmm"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"out"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"bad"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":[` + imageJSON + `]}]}}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"hidden"}}`,
		`{"isSidechain":true,"type":"user","message":{"role":"user","content":"hidden"}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}`,
		`{"type":"assistant","isApiErrorMessage":true,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"rate limited"}]}}`,
		`{"type":"system","subtype":"compact_boundary","message":{"role":"system","content":"x"}}`,
		`{"type":"system","subtype":"other","message":{"role":"system","content":"x"}}`,
		`{"type":"user","timestamp":"2026-11-03T10:00:00.000Z","message":{"role":"user","content":"dated"}}`,
		`{"timestamp":"2026-11-03T10:00:00.000Z","message":{"role":"user","content":"dated"},"type":"user"}`,
		`{"type":"user","message":{"role":"user","content":"hello"},"toolUseResult":{"stdout":"` + strings.Repeat("x", 64<<10) + `"}}`,
		`{"type":"user","type":"user","message":{"role":"user","content":"twice"}}`,
		`{"type":"user","message":{"role":"user","content":"one"},"message":{"role":"user","content":"two"}}`,
		`{"type":"us` + string(rune(0x5c)) + `u0065r","message":{"role":"user","content":"escaped"}}`,
		`{"type":"user","message":[],"content":"x"}`,
		`{"message":{"role":"user","content":"no type"}}`,
		`{"type":"user"`,
		`[]`,
	}
	for _, line := range lines {
		var item claudeTraceRecord
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			if events := parseClaudeTrace([]byte(line)); len(events) != 0 {
				t.Fatalf("undecodable record %s produced %+v", line, events)
			}
			continue
		}
		want := parseClaudeRecord(item)
		got := parseClaudeTrace([]byte(line))
		if len(got) == 0 && len(want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("record %s:\n scan=%+v\n full=%+v", line[:min(len(line), 120)], got, want)
		}
	}
}

func TestClaudePrefilterFallsBackOnAmbiguousRecords(t *testing.T) {
	// A duplicate type decodes last-wins, so the record is parsed normally.
	line := []byte(`{"type":"attachment","type":"user","message":{"role":"user","content":"hello"}}`)
	events := parseClaudeTrace(line)
	if len(events) != 1 || events[0].Type != "user" || events[0].Text != "hello" {
		t.Fatalf("duplicate type record=%+v", events)
	}
	// Bookkeeping types never reach the decoder.
	if events := parseClaudeTrace([]byte(`{"type":"attachment","payload":{"text":"x"}}`)); len(events) != 0 {
		t.Fatalf("attachment record produced %+v", events)
	}
}
