package journal

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func clipEventPromptly(t *testing.T, event Event, limit int, already bool) (Event, bool) {
	t.Helper()
	type result struct {
		event     Event
		truncated bool
	}
	done := make(chan result, 1)
	go func() {
		clipped, truncated := clipEventToLimit(event, limit, already)
		done <- result{event: clipped, truncated: truncated}
	}()
	select {
	case got := <-done:
		return got.event, got.truncated
	case <-time.After(time.Second):
		t.Fatal("clipEventToLimit did not terminate")
		return Event{}, false
	}
}

func TestClipEventToLimitMakesProgressForFiveAndSixByteFields(t *testing.T) {
	for _, text := range []string{"abcde", "abcdef"} {
		t.Run(text, func(t *testing.T) {
			base := Event{Type: "tool", Name: "read"}
			limit := eventSize(base)
			got, truncated := clipEventPromptly(t, Event{Type: base.Type, Name: base.Name, Output: text}, limit, false)
			if !truncated || eventSize(got) > limit {
				t.Fatalf("got=%+v size=%d truncated=%v", got, eventSize(got), truncated)
			}
		})
	}
}

func TestClipEventToLimitKeepsUTF8Valid(t *testing.T) {
	base := Event{Type: "assistant"}
	got, truncated := clipEventPromptly(t, Event{Type: "assistant", Text: "甲乙丙丁尾"}, eventSize(base)+6, false)
	if !truncated || !utf8.ValidString(got.Text) || eventSize(got) > eventSize(base)+6 {
		t.Fatalf("got=%q size=%d valid=%v truncated=%v", got.Text, eventSize(got), utf8.ValidString(got.Text), truncated)
	}
}

func TestClipEventToLimitReturnsOversizedMetadataForCallerToReject(t *testing.T) {
	for _, limit := range []int{-1, 0, 1} {
		got, truncated := clipEventPromptly(t, Event{Type: "tool", Name: "metadata"}, limit, false)
		if got.Type != "tool" || got.Name != "metadata" || truncated || eventSize(got) <= limit {
			t.Fatalf("limit=%d got=%+v size=%d truncated=%v", limit, got, eventSize(got), truncated)
		}

		withPayload, clipped := clipEventPromptly(t, Event{Type: "tool", Name: "metadata", Output: "abcde"}, limit, false)
		if !clipped || withPayload.Output != "" || eventSize(withPayload) <= limit {
			t.Fatalf("payload limit=%d got=%+v size=%d truncated=%v", limit, withPayload, eventSize(withPayload), clipped)
		}
	}
}

func TestClipEventToLimitBoundsLargeToolTail(t *testing.T) {
	const limit = 512
	input := strings.Repeat("参数<>&", 8_000)
	output := strings.Repeat("output-", 20_000)
	got, truncated := clipEventPromptly(t, Event{Type: "tool", Name: "exec_command", Input: input, Output: output}, limit, false)
	if !truncated || eventSize(got) > limit {
		t.Fatalf("size=%d truncated=%v", eventSize(got), truncated)
	}
	if got.Type != "tool" || got.Name != "exec_command" || !utf8.ValidString(got.Input) || !utf8.ValidString(got.Output) {
		t.Fatalf("metadata or UTF-8 damaged: %+v", got)
	}
}

func TestClipEventKeepsToolOutputHeadAndTail(t *testing.T) {
	body := "go test ./...\n" + strings.Repeat("ok  pairfob/internal/x 0.1s\n", 8_000) + "FAIL: 2 tests failed"
	got, truncated := clipEvent(Event{Type: "tool", Name: "Bash", Input: body, Output: body, Text: body}, false)
	if !truncated || !strings.HasPrefix(got.Output, "go test ./...") || !strings.HasSuffix(got.Output, "FAIL: 2 tests failed") {
		t.Fatalf("output lost its head or tail: %q … %q", got.Output[:20], got.Output[len(got.Output)-20:])
	}
	if !strings.Contains(got.Output, toolOutputGap) || len(got.Output) > maxMessageBytes+len("…") {
		t.Fatalf("output bytes=%d gap=%v", len(got.Output), strings.Contains(got.Output, toolOutputGap))
	}
	for _, prefixClipped := range []string{got.Input, got.Text} {
		if strings.Contains(prefixClipped, "FAIL") || !strings.HasSuffix(prefixClipped, "…") || len(prefixClipped) > maxMessageBytes+len("…") {
			t.Fatalf("input/text must keep prefix clipping: bytes=%d", len(prefixClipped))
		}
	}
}

func TestClipEventToLimitShrinksToolOutputAroundItsMiddle(t *testing.T) {
	output := "开始" + strings.Repeat("输出<>&", 20_000) + "结尾总结"
	for _, limit := range []int{256, 4 << 10, 40 << 10} {
		got, truncated := clipEventPromptly(t, Event{Type: "tool", Name: "exec_command", Output: output}, limit, false)
		if !truncated || eventSize(got) > limit || !utf8.ValidString(got.Output) {
			t.Fatalf("limit=%d size=%d valid=%v", limit, eventSize(got), utf8.ValidString(got.Output))
		}
		if !strings.HasPrefix(got.Output, "开始") || !strings.HasSuffix(got.Output, "结尾总结") || strings.Count(got.Output, "…") != 1 {
			t.Fatalf("limit=%d output=%q", limit, got.Output)
		}
	}
}

func TestHeadTailStaysOnRuneBoundaries(t *testing.T) {
	text := strings.Repeat("甲乙", 100)
	for keep := 2; keep < 40; keep++ {
		got := headTail(text, keep)
		if !utf8.ValidString(got) || len(got) > keep+len(toolOutputGap) {
			t.Fatalf("keep=%d got=%q", keep, got)
		}
	}
}
