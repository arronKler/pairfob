package journal

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestActivityWindowMatchesColdScanAcrossGrowthAndRewrites(t *testing.T) {
	for _, agent := range []string{"codex", "claude", "grok"} {
		var previous []activityRecord
		data := []byte("{\"type\":\"session_meta\"}\n")
		for n := 0; n < 100; n++ {
			data = append(data, []byte(`{"type":"event_msg","payload":{"type":"task_started"}}`+"\n")...)
			if n%3 == 0 {
				data = append(data, []byte("broken\n")...)
			}
			if n%5 == 0 {
				data = append(data, []byte(`{"type":"user","message":{"role":"user","content":"go"}}`+"\n")...)
			}
			if n%7 == 0 {
				data[4] ^= 1
			} // Rewrite before the append boundary.
			if n%13 == 0 {
				data = data[len(data)/2:]
			}
			for _, offset := range []int64{0, 42} {
				got, next, _ := scanActivityWindow(agent, data, offset, previous)
				if want := scanActivity(agent, data, offset); got != want {
					t.Fatalf("%s step %d offset %d: got %+v want %+v", agent, n, offset, got, want)
				}
				previous = next
			}
		}
	}
}

func TestActivityWindowPartialRecordsAndSlidingBoundary(t *testing.T) {
	data := []byte(strings.Repeat("{}\n", activityReadBytes/3) + `{"type":"event_msg","payload":{"type":"task_complete"}}` + "\n")
	var previous []activityRecord
	for n := 0; n < 8; n++ {
		data = append(data, []byte(`{"type":"event_msg","payload":{"type":"user_message"}}` + "\n")[n%54])
		start := max(0, len(data)-activityReadBytes)
		got, next, _ := scanActivityWindow("codex", data[start:], int64(start), previous)
		if want := scanActivity("codex", data[start:], int64(start)); got != want {
			t.Fatalf("step %d got %+v want %+v", n, got, want)
		}
		if len(next) > maxActivityRecords {
			t.Fatal("unbounded cache")
		}
		previous = next
	}
}

func TestActivityLocksOnlyTheSameTranscript(t *testing.T) {
	r := &Reader{}
	release := r.lockActivity("one")
	done := make(chan struct{})
	go func() { defer close(done); unlock := r.lockActivity("two"); unlock() }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("unrelated transcript blocked")
	}
	blocked := make(chan struct{})
	go func() { unlock := r.lockActivity("one"); unlock(); close(blocked) }()
	select {
	case <-blocked:
		t.Fatal("same transcript overlapped")
	case <-time.After(10 * time.Millisecond):
	}
	release()
	<-blocked
	if len(r.activityFlights) != 0 {
		t.Fatal("retained idle locks")
	}
}

func activityBenchWindow() []byte {
	line := []byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + strings.Repeat("x", 4096) + `"}]}}` + "\n")
	return bytes.Repeat(line, activityReadBytes/len(line))
}

func BenchmarkActivityGrowingWindow(b *testing.B) {
	base := activityBenchWindow()
	_, previous, _ := scanActivityWindow("claude", base, 0, nil)
	data := append(append([]byte(nil), base...), []byte(`{"type":"user","message":{"role":"user","content":"next"}}`+"\n")...)
	b.Run("baseline", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			scanActivity("claude", data, 0)
		}
	})
	b.Run("candidate", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			scanActivityWindow("claude", data, 0, previous)
		}
	})
	_, _, parsed := scanActivityWindow("claude", data, 0, previous)
	b.Logf("window_bytes=%d newly_parsed_bytes=%d", len(data), parsed)
}
