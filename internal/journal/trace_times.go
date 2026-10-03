package journal

import (
	"encoding/json"
	"math"
	"strings"
	"time"
)

// Trace times (TraceOptions.Times, GetConfig.capabilities.trace_times) stamp
// each summary item with the time of the transcript record it came from, in
// milliseconds since the Unix epoch. Parsers always read the record time; adapt
// clears it unless the client opted in, so it never reaches older clients.

const (
	// minTraceTimeMillis is 2000-01-01T00:00:00Z; earlier record times are bogus.
	minTraceTimeMillis = 946684800000
	// maxTraceTimeSkew bounds how far in the future a record time may lie.
	maxTraceTimeSkew = 24 * time.Hour
	// traceMillisFloor separates epoch milliseconds from epoch seconds: any
	// plausible seconds value is far below it, any plausible millisecond far above.
	traceMillisFloor = 1e11
)

// recordTime reads a transcript timestamp: an RFC 3339 string (fractional
// seconds and offsets allowed) or a JSON number of epoch seconds or
// milliseconds. It returns 0 when the value is missing, unparseable or
// implausible, so the item simply carries no time.
func recordTime(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var millis int64
	var text string
	var number float64
	switch {
	case json.Unmarshal(raw, &text) == nil:
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(text))
		if err != nil {
			return 0
		}
		millis = parsed.UnixMilli()
	case json.Unmarshal(raw, &number) == nil:
		if math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 || number > math.MaxInt64/2 {
			return 0
		}
		if number < traceMillisFloor {
			number *= 1000
		}
		millis = int64(math.Round(number))
	default:
		return 0
	}
	if millis < minTraceTimeMillis || millis > time.Now().Add(maxTraceTimeSkew).UnixMilli() {
		return 0
	}
	return millis
}

// stampEvents gives every event parsed from one record that record's time,
// taken from the first candidate that parses, so an agent's own precise clock
// can win over a coarser write time.
func stampEvents(events []parsedEvent, candidates ...json.RawMessage) {
	if len(events) == 0 {
		return
	}
	var at int64
	for _, raw := range candidates {
		if at = recordTime(raw); at != 0 {
			break
		}
	}
	for i := range events {
		events[i].At = at
	}
}
