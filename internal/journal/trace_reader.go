package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
)

const (
	traceInitialReadBytes = 512 << 10
	traceMaxReadChunk     = 4 << 20
	maxTraceCacheEntries  = 32
)

type traceParser func([]byte) []parsedEvent

type traceCacheKey struct {
	path    string
	limit   int
	options TraceOptions
}

type traceCacheEntry struct {
	size     int64
	modified int64
	page     TracePage
}

type traceWindow struct {
	items     []parsedEvent
	starts    []int
	limit     int
	pageBytes int
	older     bool
	truncated bool
	// skipped records a record too large to decode; its content is missing.
	skipped bool
	orphan  *parsedEvent
}

func (r *Reader) ReadTrace(ref Ref, cursor *string, limit int) (TracePage, error) {
	return r.ReadTraceWith(ref, cursor, limit, TraceOptions{})
}

func (r *Reader) ReadTraceWith(ref Ref, cursor *string, limit int, options TraceOptions) (TracePage, error) {
	if !r.Supports(ref) {
		return TracePage{}, ErrUnavailable
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		return TracePage{}, errors.New("invalid history limit")
	}
	if ref.Agent == "pi" {
		return r.readPiTrace(ref, cursor, limit, options)
	}
	end, err := decodeCursor(ref, cursor)
	if err != nil {
		return TracePage{}, err
	}
	source, err := r.openTranscript(ref, true)
	if err != nil {
		return TracePage{}, err
	}
	defer source.Close()
	key := traceCacheKey{path: source.name, limit: limit, options: options}
	if cursor == nil {
		if page, ok := r.cachedTracePage(key, source); ok {
			return page, nil
		}
	}
	page, _, err := readTracePage(source, ref, end, limit, traceParserFor(ref.Agent), options)
	if err == nil && cursor == nil && source.unchanged() {
		r.cacheTracePage(key, source, page)
	}
	return page, err
}

func (r *Reader) ReadTraceSummary(ref Ref, cursor *string, limit int) (TraceSummaryPage, error) {
	return r.ReadTraceSummaryWith(ref, cursor, limit, TraceOptions{})
}

func (r *Reader) ReadTraceSummaryWith(ref Ref, cursor *string, limit int, options TraceOptions) (TraceSummaryPage, error) {
	page, err := r.ReadTraceWith(ref, cursor, limit, options)
	if err != nil {
		return TraceSummaryPage{}, err
	}
	items := make([]TraceSummaryItem, 0, len(page.Items))
	for _, item := range page.Items {
		if item.Type == "tool" {
			items = append(items, TraceSummaryItem{
				Type: item.Type, Name: item.Name, State: traceToolState(item), DetailRef: item.DetailRef, Label: item.Label, At: item.At,
			})
			continue
		}
		items = append(items, TraceSummaryItem{Type: item.Type, Text: item.Text, At: item.At})
	}
	fitSummaryExtras(items)
	return TraceSummaryPage{Items: items, NextCursor: page.NextCursor, Truncated: page.SummaryTruncated}, nil
}

// fitSummaryExtras keeps a summary with opt-in labels and times inside the
// page budget. Neither counts toward the full trace page it was cut from (labels
// come from unclipped input), so pages, cursors and detail refs match every
// view; when the extras overflow, the oldest labels go first, then the oldest
// times.
func fitSummaryExtras(items []TraceSummaryItem) {
	if !slices.ContainsFunc(items, func(item TraceSummaryItem) bool { return item.Label != "" || item.At != 0 }) {
		return
	}
	total := 0
	for _, item := range items {
		total += summaryItemSize(item)
	}
	drops := []func(*TraceSummaryItem) bool{
		func(item *TraceSummaryItem) bool { dropped := item.Label != ""; item.Label = ""; return dropped },
		func(item *TraceSummaryItem) bool { dropped := item.At != 0; item.At = 0; return dropped },
	}
	for _, drop := range drops {
		for i := 0; i < len(items) && total > maxTraceItemsBytes; i++ {
			before := summaryItemSize(items[i])
			if drop(&items[i]) {
				total -= before - summaryItemSize(items[i])
			}
		}
	}
}

func summaryItemSize(item TraceSummaryItem) int {
	encoded, err := json.Marshal(item)
	if err != nil {
		return maxTraceItemsBytes + 1
	}
	return len(encoded) + 1
}

func (r *Reader) cachedTracePage(key traceCacheKey, source *transcript) (TracePage, bool) {
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	entry, ok := r.traceCache[key]
	if !ok || entry.size != source.size || entry.modified != source.modified {
		return TracePage{}, false
	}
	return cloneTracePage(entry.page), true
}

func (r *Reader) cacheTracePage(key traceCacheKey, source *transcript, page TracePage) {
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	if r.traceCache == nil || len(r.traceCache) >= maxTraceCacheEntries {
		r.traceCache = make(map[traceCacheKey]traceCacheEntry)
	}
	r.traceCache[key] = traceCacheEntry{size: source.size, modified: source.modified, page: cloneTracePage(page)}
}

func cloneTracePage(page TracePage) TracePage {
	copyPage := TracePage{
		Items: append([]Event(nil), page.Items...), Truncated: page.Truncated, SummaryTruncated: page.SummaryTruncated,
	}
	if page.NextCursor != nil {
		next := *page.NextCursor
		copyPage.NextCursor = &next
	}
	return copyPage
}

func readTracePage(source *transcript, ref Ref, end, limit int, parse traceParser, options TraceOptions) (page TracePage, scanned int, err error) {
	if end <= 0 || int64(end) > source.size {
		end = int(source.size)
	}
	start := end
	chunkSize := traceInitialReadBytes
	var data []byte
	var window traceWindow
	alignedStart := end
	limited := false

	for {
		remainingBudget := maxScanBytes - scanned
		if start == 0 || remainingBudget <= 0 {
			limited = start > 0
			break
		}
		readBytes := min(chunkSize, start, remainingBudget)
		nextStart := start - readBytes
		chunk := make([]byte, readBytes)
		read, err := source.reader.ReadAt(chunk, int64(nextStart))
		if err != nil && err != io.EOF {
			return TracePage{}, scanned, err
		}
		if read != readBytes {
			return TracePage{}, scanned, io.ErrUnexpectedEOF
		}
		data = append(chunk, data...)
		scanned += readBytes
		start = nextStart

		view := data
		alignedStart = start
		if start > 0 {
			newline := bytes.IndexByte(view, '\n')
			if newline < 0 {
				chunkSize = min(chunkSize*2, traceMaxReadChunk)
				continue
			}
			view = view[newline+1:]
			alignedStart += newline + 1
		}
		window, err = parseTraceWindow(view, alignedStart, limit, parse, options)
		if err != nil {
			return TracePage{}, scanned, err
		}
		if traceWindowComplete(window, start == 0) {
			break
		}
		chunkSize = min(chunkSize*2, traceMaxReadChunk)
	}

	if int64(end) < source.size {
		// An older page: records after it exist, whatever they hold.
		window.settleBefore(end)
	}
	return window.page(ref, alignedStart, limited), scanned, nil
}

func parseTraceWindow(data []byte, base, limit int, parse traceParser, options TraceOptions) (traceWindow, error) {
	window := traceWindow{items: make([]parsedEvent, 0, limit), starts: make([]int, 0, limit), limit: limit}
	dropFront := func() {
		if len(window.items) == 0 {
			return
		}
		window.older = true
		if turnHead(window.items[0].Type) {
			copy := window.items[0]
			window.orphan = &copy
		}
		window.pageBytes -= eventSize(window.items[0].Event)
		window.items = window.items[1:]
		window.starts = window.starts[1:]
	}

	position := base
	err := forEachLine(bytes.NewReader(data), maxTraceLine, func(line []byte, lineSize int, oversized bool) bool {
		lineStart := position
		position += lineSize
		if oversized {
			window.skipped = true
			return true
		}
		for ordinal, event := range parse(line) {
			if event.settles {
				window.settleBefore(lineStart)
				if event.Type == "" {
					continue
				}
			}
			event, keep := options.adapt(event)
			if !keep {
				continue
			}
			event.lineStart = lineStart
			event.sourceOrdinal = ordinal
			if event.outputOnly {
				if item, attached := outputTarget(window.items, event.call, event.Output); attached {
					if item != nil {
						window.pageBytes -= eventSize(item.Event)
						attachOutput(item, event)
						item.Event, item.DetailTruncated = clipEvent(item.Event, item.DetailTruncated)
						item.Event, item.DetailTruncated = clipEventToLimit(item.Event, maxTraceItemsBytes-window.pageBytes, item.DetailTruncated)
						window.truncated = window.truncated || item.DetailTruncated
						window.pageBytes += eventSize(item.Event)
					}
					continue
				}
				if event.Name == "" {
					continue
				}
			}
			if canMerge(window.items, event) {
				last := &window.items[len(window.items)-1]
				window.pageBytes -= eventSize(last.Event)
				last.Text += event.Text
				var clipped bool
				last.Event, clipped = clipEvent(last.Event, false)
				last.Event, clipped = clipEventToLimit(last.Event, maxTraceItemsBytes-window.pageBytes, clipped)
				last.SummaryTruncated = last.SummaryTruncated || clipped
				window.truncated = window.truncated || clipped
				window.pageBytes += eventSize(last.Event)
				continue
			}
			var clipped bool
			event.Event, clipped = clipEvent(event.Event, false)
			if event.Type == "tool" {
				event.DetailTruncated = clipped
			} else {
				event.SummaryTruncated = clipped
			}
			window.truncated = window.truncated || clipped
			size := eventSize(event.Event)
			for len(window.items) >= limit || (len(window.items) > 0 && window.pageBytes+size > maxTraceItemsBytes) {
				dropFront()
			}
			window.items = append(window.items, event)
			window.starts = append(window.starts, lineStart)
			window.pageBytes += size
		}
		return true
	})
	return window, err
}

// settleBefore marks unresulted tools recorded before lineStart as done: a
// later record exists, so they are no longer running. Their result is unknown.
func (window *traceWindow) settleBefore(lineStart int) {
	for i := len(window.items) - 1; i >= 0; i-- {
		item := &window.items[i]
		if !item.unresulted || item.lineStart >= lineStart {
			continue
		}
		if item.State != "" {
			return
		}
		item.State = "done"
	}
}

func traceWindowComplete(window traceWindow, atStart bool) bool {
	if atStart {
		return true
	}
	if len(window.items) == 0 {
		return false
	}
	return turnHead(window.items[0].Type) || window.orphan != nil || window.older
}

func (window *traceWindow) page(ref Ref, scanStart int, limited bool) TracePage {
	if window.orphan != nil {
		for len(window.items) > 1 && window.pageBytes+eventSize(window.orphan.Event) > maxTraceItemsBytes {
			window.pageBytes -= eventSize(window.items[0].Event)
			window.items = window.items[1:]
			window.starts = window.starts[1:]
		}
	}
	page := TracePage{
		Items: make([]Event, 0, len(window.items)+1), Truncated: window.truncated || window.skipped || limited,
		SummaryTruncated: window.skipped || limited,
	}
	if window.orphan != nil && len(window.items) < window.limit && (len(window.items) == 0 || !turnHead(window.items[0].Type)) && window.pageBytes+eventSize(window.orphan.Event) <= maxTraceItemsBytes {
		page.Items = append(page.Items, window.orphan.Event)
		page.SummaryTruncated = page.SummaryTruncated || window.orphan.SummaryTruncated
	}
	for _, event := range window.items {
		item := event.Event
		if item.Type == "tool" {
			item.DetailRef = encodeTraceDetailRef(ref, event)
		} else {
			page.SummaryTruncated = page.SummaryTruncated || item.SummaryTruncated
		}
		page.Items = append(page.Items, item)
	}
	if scanStart > 0 || window.older {
		offset := scanStart
		if len(window.starts) > 0 {
			offset = window.starts[0]
		}
		if offset > 0 {
			next := encodeCursor(ref, offset)
			page.NextCursor = &next
		}
	}
	return page
}
