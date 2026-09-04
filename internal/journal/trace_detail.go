package journal

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func traceToolState(item Event) string {
	if item.Output == "" {
		return "running"
	}
	switch strings.ToLower(strings.TrimSpace(item.Output)) {
	case "失败", "failed", "error", "errored":
		return "error"
	default:
		return "done"
	}
}

func traceDetailStatic(event parsedEvent) string {
	sum := sha256.Sum256([]byte(event.Name + "\x00" + event.call))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

func traceDetailRevision(event Event) string {
	sum := sha256.Sum256([]byte(event.Text + "\x00" + event.Input + "\x00" + event.Output))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

func encodeTraceDetailRef(ref Ref, event parsedEvent) string {
	// The final component only busts the PWA cache when a running tool grows.
	// Location authority comes from the trusted Ref, offset, ordinal, and static identity.
	raw := fmt.Sprintf("d1:%s:%d:%d:%s:%s", refFingerprint(ref), event.lineStart, event.sourceOrdinal, traceDetailStatic(event), traceDetailRevision(event.Event))
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

type traceDetailLocator struct {
	offset  int
	ordinal int
	static  string
}

func decodeTraceDetailRef(ref Ref, detailRef string) (traceDetailLocator, error) {
	if detailRef == "" || len(detailRef) > 1024 {
		return traceDetailLocator{}, ErrCursorInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(detailRef)
	if err != nil {
		return traceDetailLocator{}, ErrCursorInvalid
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) != 6 || parts[0] != "d1" || parts[1] != refFingerprint(ref) || parts[4] == "" || parts[5] == "" {
		return traceDetailLocator{}, ErrCursorConflict
	}
	offset, offsetErr := strconv.Atoi(parts[2])
	ordinal, ordinalErr := strconv.Atoi(parts[3])
	if offsetErr != nil || ordinalErr != nil || offset < 0 || ordinal < 0 || ordinal > 1024 {
		return traceDetailLocator{}, ErrCursorInvalid
	}
	return traceDetailLocator{offset: offset, ordinal: ordinal, static: parts[4]}, nil
}

func traceParserFor(ref Ref) traceParser {
	switch ref.Agent {
	case "codex":
		return parseCodexTrace
	case "claude":
		return parseClaudeTrace
	default:
		return parseGrokTrace
	}
}

// ReadTraceDetail resolves one server-issued locator against the same trusted
// pane transcript. The phone never supplies a path or an agent session id.
func (r *Reader) ReadTraceDetail(ref Ref, detailRef string) (TraceDetail, error) {
	if !r.Supports(ref) {
		return TraceDetail{}, ErrUnavailable
	}
	locator, err := decodeTraceDetailRef(ref, detailRef)
	if err != nil {
		return TraceDetail{}, err
	}
	path, err := r.transcriptPath(ref, true)
	if err != nil {
		return TraceDetail{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return TraceDetail{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return TraceDetail{}, err
	}
	if int64(locator.offset) >= info.Size() {
		return TraceDetail{}, ErrCursorConflict
	}
	if _, err := file.Seek(int64(locator.offset), 0); err != nil {
		return TraceDetail{}, err
	}

	parse := traceParserFor(ref)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), maxTranscriptLine)
	var target *parsedEvent
	scanned := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		scanned += len(line) + 1
		if scanned > maxScanBytes {
			break
		}
		events := parse(line)
		start := 0
		if target == nil {
			if locator.ordinal >= len(events) {
				return TraceDetail{}, ErrCursorConflict
			}
			selected := events[locator.ordinal]
			if selected.Type != "tool" || selected.outputOnly || selected.Name == "" || traceDetailStatic(selected) != locator.static {
				return TraceDetail{}, ErrCursorConflict
			}
			target = &selected
			start = locator.ordinal + 1
		}
		for _, event := range events[start:] {
			if !event.outputOnly {
				continue
			}
			if item, attached := outputTarget([]parsedEvent{*target}, event.call, event.Output); attached && item != nil {
				target.Output = event.Output
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return TraceDetail{}, err
	}
	if target == nil {
		return TraceDetail{}, ErrCursorConflict
	}
	item, truncated := clipEvent(target.Event, scanned > maxScanBytes)
	return TraceDetail{
		DetailRef: detailRef, Text: item.Text, Input: item.Input, Output: item.Output, Truncated: truncated,
	}, nil
}
