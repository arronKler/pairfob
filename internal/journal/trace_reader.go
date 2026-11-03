package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
)

const (
	traceInitialReadBytes = 512 << 10
	traceMaxReadChunk     = 4 << 20
	maxTraceCacheEntries  = 32
	// traceCacheAnchorBytes is how much of the parsed prefix a resumed read checks
	// still matches before it trusts the cached window as append-only.
	traceCacheAnchorBytes = 256
	// A window large enough to be worth splitting is parsed on several cores.
	// Small reads keep the plain path: a goroutine costs more than it saves.
	traceParallelMinBytes = 256 << 10
	traceParallelWorkers  = 8
)

type traceParser func([]byte) []parsedEvent

// traceDataPool reuses the buffer a growing tail window is read into. A cold
// read doubles its window a few times; keeping that memory lets the next cold
// session start without allocating it again.
var traceDataPool sync.Pool

func traceDataBuffer(size int) []byte {
	if buffer, ok := traceDataPool.Get().([]byte); ok && cap(buffer) >= size {
		return buffer[:size]
	}
	return make([]byte, size)
}

type traceCacheKey struct {
	path    string
	limit   int
	options TraceOptions
}

// traceCacheEntry is the parsed tail window of one transcript at one parser
// setting. A growing log resumes from `tail` instead of scanning the window
// again, so a poll costs the bytes that arrived, not the bytes on screen.
type traceCacheEntry struct {
	size     int64
	modified int64
	// tail is the offset just past the last line the parse consumed.
	tail int
	// start is the offset of the first line the window holds.
	start   int
	limited bool
	// anchor is the bytes just before tail, proving the prefix did not change.
	anchor []byte
	window traceWindow
}

// traceRead is one tail read: the page plus what a later read needs to resume
// from the same parse.
type traceRead struct {
	page    TracePage
	tail    int
	start   int
	whole   bool
	scanned int
	// limited records that the scan budget, not the turn head, ended the read.
	limited bool
	window  traceWindow
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
	if piAgent(ref.Agent) {
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
		if page, ok := r.cachedTracePage(key, source, ref); ok {
			return page, nil
		}
		if page, ok := r.resumeTracePage(key, source, ref, limit, options); ok {
			return page, nil
		}
	}
	read, err := readTrace(source, ref, end, limit, traceParserFor(ref.Agent), options)
	if err != nil {
		return TracePage{}, err
	}
	if cursor == nil && read.whole {
		r.cacheTracePage(key, source, read)
	}
	return read.page, nil
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
				Type: item.Type, Name: item.Name, State: traceToolState(item), DetailRef: item.DetailRef, Label: item.Label, Writes: item.Writes, At: item.At, Models: item.Models,
			})
			continue
		}
		items = append(items, TraceSummaryItem{Type: item.Type, Text: item.Text, At: item.At, Models: item.Models})
	}
	fitSummaryExtras(items)
	return TraceSummaryPage{Items: items, NextCursor: page.NextCursor, Truncated: page.SummaryTruncated}, nil
}

// fitSummaryExtras keeps a summary with opt-in labels, written paths and times
// inside the page budget. None counts toward the full trace page it was cut
// from (labels and paths come from unclipped input), so pages, cursors and
// detail refs match every view; when the extras overflow, the oldest labels go
// first, then the oldest written paths, then the oldest times.
func fitSummaryExtras(items []TraceSummaryItem) {
	for i := range items {
		if len(items[i].Models) > 32 {
			items[i].Models = nil
		}
	}
	if !slices.ContainsFunc(items, func(item TraceSummaryItem) bool {
		return item.Label != "" || len(item.Writes) > 0 || item.At != 0 || len(item.Models) > 0
	}) {
		return
	}
	total := 0
	for _, item := range items {
		total += summaryItemSize(item)
	}
	drops := []func(*TraceSummaryItem) bool{
		func(item *TraceSummaryItem) bool { dropped := len(item.Models) > 0; item.Models = nil; return dropped },
		func(item *TraceSummaryItem) bool { dropped := item.Label != ""; item.Label = ""; return dropped },
		func(item *TraceSummaryItem) bool { dropped := len(item.Writes) > 0; item.Writes = nil; return dropped },
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

func (r *Reader) cachedTracePage(key traceCacheKey, source *transcript, ref Ref) (TracePage, bool) {
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	entry, ok := r.traceCache[key]
	if !ok || entry.size != source.size || entry.modified != source.modified {
		return TracePage{}, false
	}
	// The page builder trims the window it is given, so it gets a copy; the
	// parsed events it reads are shared and never written by it.
	window := entry.window
	return detachPageModels(window.page(ref, entry.start, entry.limited)), true
}

// detachPageModels gives the caller its own model lists, so no page handed out
// can rewrite the parse a later read resumes from.
func detachPageModels(page TracePage) TracePage {
	for i := range page.Items {
		page.Items[i].Models = slices.Clone(page.Items[i].Models)
	}
	return page
}

func (r *Reader) cacheTracePage(key traceCacheKey, source *transcript, read traceRead) {
	anchor := make([]byte, min(traceCacheAnchorBytes, read.tail))
	if _, err := source.reader.ReadAt(anchor, int64(read.tail-len(anchor))); err != nil && !errors.Is(err, io.EOF) {
		return
	}
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	if r.traceCache == nil || len(r.traceCache) >= maxTraceCacheEntries {
		r.traceCache = make(map[traceCacheKey]traceCacheEntry)
	}
	r.traceCache[key] = traceCacheEntry{
		size: source.size, modified: source.modified, tail: read.tail, start: read.start,
		limited: read.limited, anchor: anchor, window: read.window,
	}
}

// resumeTracePage answers a tail read from the cached window plus the bytes
// appended since, and falls back to a full read whenever the prefix cannot be
// proven to be the one already parsed.
func (r *Reader) resumeTracePage(key traceCacheKey, source *transcript, ref Ref, limit int, options TraceOptions) (TracePage, bool) {
	r.traceMu.Lock()
	entry, ok := r.traceCache[key]
	r.traceMu.Unlock()
	if !ok || entry.tail <= 0 || entry.tail > int(source.size) || source.size <= entry.size {
		return TracePage{}, false
	}
	// A rewrite that grows the file is not an append; the anchor catches it.
	if len(entry.anchor) > 0 {
		seen := make([]byte, len(entry.anchor))
		if _, err := source.reader.ReadAt(seen, int64(entry.tail-len(seen))); err != nil && !errors.Is(err, io.EOF) {
			return TracePage{}, false
		}
		if !bytes.Equal(seen, entry.anchor) {
			return TracePage{}, false
		}
	}
	if int(source.size)-entry.tail > maxScanBytes {
		return TracePage{}, false
	}
	data := make([]byte, int(source.size)-entry.tail)
	if _, err := source.reader.ReadAt(data, int64(entry.tail)); err != nil && !errors.Is(err, io.EOF) {
		return TracePage{}, false
	}
	window, tail, whole, err := extendTraceWindow(entry.window, data, entry.tail, limit, traceParserFor(ref.Agent), options)
	if err != nil || !whole {
		// A trailing partial line belongs to the next write; parse it in a full
		// read, the way a cold read would, and do not cache this pass.
		return TracePage{}, false
	}
	read := traceRead{
		page: detachPageModels(window.page(ref, entry.start, entry.limited)), tail: tail,
		start: entry.start, whole: true, limited: entry.limited, window: window,
	}
	r.cacheTracePage(key, source, read)
	return read.page, true
}

// readTracePage is the measurement seam tests use: the page and the bytes the
// scan read.
func readTracePage(source *transcript, ref Ref, end, limit int, parse traceParser, options TraceOptions) (TracePage, int, error) {
	read, err := readTrace(source, ref, end, limit, parse, options)
	return read.page, read.scanned, err
}

func readTrace(source *transcript, ref Ref, end, limit int, parse traceParser, options TraceOptions) (traceRead, error) {
	if end <= 0 || int64(end) > source.size {
		end = int(source.size)
	}
	start := end
	chunkSize := traceInitialReadBytes
	var data []byte
	defer func() {
		if data != nil {
			traceDataPool.Put(data[:0])
		}
	}()
	var window traceWindow
	alignedStart := end
	scanned := 0
	limited := false
	// A model-aware parser carries context from one record to the next, so it
	// must see the whole window in order. The plain parsers are line-local:
	// what they already parsed is kept when the window grows, and only the
	// bytes that were not parsed before are read again.
	var stateful traceParser
	if options.Models {
		stateful = traceParserWithModels(ref.Agent, parse)
	}
	parsedFrom := end
	parsed := false
	skipped := false

	for {
		remainingBudget := maxScanBytes - scanned
		if start == 0 || remainingBudget <= 0 {
			limited = start > 0
			break
		}
		readBytes := min(chunkSize, start, remainingBudget)
		nextStart := start - readBytes
		// Grow the window at the front in one movable buffer: shift what was
		// already read to the right, then read the older bytes into the space.
		// Reusing the buffer keeps a growing window from allocating a new copy
		// on every doubling.
		oldLen := len(data)
		if cap(data) < oldLen+readBytes {
			grown := traceDataBuffer(oldLen + readBytes)
			copy(grown[readBytes:], data)
			if data != nil {
				traceDataPool.Put(data[:0])
			}
			data = grown
		} else {
			data = data[:oldLen+readBytes]
			copy(data[readBytes:], data[:oldLen])
		}
		read, err := source.reader.ReadAt(data[:readBytes], int64(nextStart))
		if err != nil && err != io.EOF {
			return traceRead{}, err
		}
		if read != readBytes {
			return traceRead{}, io.ErrUnexpectedEOF
		}
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
		if stateful != nil {
			window, err = parseTraceWindow(view, alignedStart, limit, stateful, options)
		} else {
			var fresh []parsedEvent
			freshSkipped := false
			if parsedFrom > alignedStart {
				end := min(parsedFrom-alignedStart, len(view))
				fresh, freshSkipped = parseRegion(view[:end], alignedStart, parse)
				parsedFrom = alignedStart
				skipped = skipped || freshSkipped
			}
			if !parsed {
				window = buildTraceWindow(fresh, skipped, limit, options)
				parsed = true
			} else {
				window = prependTraceWindow(fresh, freshSkipped, window, options)
			}
		}
		if err != nil {
			return traceRead{}, err
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
	// The tail a later read resumes from ends at the file's last complete line;
	// a record still being written is read again once its newline arrives.
	tail := alignedStart
	if cut := bytes.LastIndexByte(data, '\n'); cut >= 0 {
		tail = start + cut + 1
	}
	stored := window
	page := detachPageModels(window.page(ref, alignedStart, limited))
	return traceRead{
		page: page, tail: tail, start: alignedStart, whole: tail == end,
		scanned: scanned, limited: limited, window: stored,
	}, nil
}

func parseTraceWindow(data []byte, base, limit int, parse traceParser, options TraceOptions) (traceWindow, error) {
	return parseTraceWindowInto(traceWindow{
		items: make([]parsedEvent, 0, limit), starts: make([]int, 0, limit), limit: limit,
	}, data, base, limit, parse, options)
}

// extendTraceWindow reads the records appended after a cached window and
// continues that window instead of scanning from the tail again. It returns
// the offset just past the last complete line, and whether the region ended on
// a line boundary.
func extendTraceWindow(window traceWindow, data []byte, base, limit int, parse traceParser, options TraceOptions) (traceWindow, int, bool, error) {
	cut := bytes.LastIndexByte(data, '\n')
	if cut < 0 {
		return window, base, false, nil
	}
	extended, err := parseTraceWindowInto(window, data[:cut+1], base, limit, parse, options)
	return extended, base + cut + 1, cut == len(data)-1, err
}

func parseTraceWindowInto(window traceWindow, data []byte, base, limit int, parse traceParser, options TraceOptions) (traceWindow, error) {
	window.limit = limit
	position := base
	forEachLineBytes(data, maxTraceLine, func(line []byte, lineSize int, oversized bool) bool {
		lineStart := position
		position += lineSize
		if oversized {
			window.skipped = true
			if options.Models {
				parse(nil)
			}
			return true
		}
		for ordinal, event := range parse(line) {
			event.lineStart = lineStart
			event.sourceOrdinal = ordinal
			window.addEvent(event, options)
		}
		return true
	})
	return window, nil
}

// buildTraceWindow folds records that were parsed earlier into one page. An
// enlarged tail window replays the records it already has instead of reading
// them from disk again; folding is cheap next to JSON decoding them.
func buildTraceWindow(events []parsedEvent, skipped bool, limit int, options TraceOptions) traceWindow {
	window := traceWindow{
		items: make([]parsedEvent, 0, limit), starts: make([]int, 0, limit), limit: limit,
		skipped: skipped,
	}
	for _, event := range events {
		window.addEvent(event, options)
	}
	return window
}

// prependTraceWindow folds records older than the window in front of it. The
// retained items were already adapted and clipped; folding them again keeps
// the byte budget, message merges and tool-output attachments continuous
// across the boundary without re-reading the records behind them.
//
// The window may already have dropped older items. Those are newer than every
// record being prepended, so their turn head stays the boundary head: a fresh
// record can only take it over when the previous window had none.
func prependTraceWindow(events []parsedEvent, skipped bool, tail traceWindow, options TraceOptions) traceWindow {
	window := traceWindow{
		items: make([]parsedEvent, 0, tail.limit), starts: make([]int, 0, tail.limit),
		limit: tail.limit, skipped: tail.skipped || skipped, truncated: tail.truncated,
		older: tail.older, orphan: tail.orphan,
	}
	for _, event := range events {
		window.addEvent(event, options)
	}
	for _, item := range tail.items {
		window.addEvent(item, options)
	}
	return window
}

// addEvent places one parsed record in the window: attach a tool result to its
// call, merge a continuation of the previous message, or append a new item.
func (window *traceWindow) addEvent(event parsedEvent, options TraceOptions) {
	if event.settles {
		window.settleBefore(event.lineStart)
		if event.Type == "" {
			return
		}
	}
	if !event.adapted {
		var keep bool
		event, keep = options.adapt(event)
		if !keep {
			return
		}
		event.adapted = true
	}
	if event.outputOnly {
		if item, attached := outputTarget(window.items, event.call, event.Output); attached {
			if item != nil {
				window.pageBytes -= item.size
				attachOutput(item, event)
				item.Event, _, item.DetailTruncated = clipEventSize(item.Event, item.DetailTruncated)
				item.Event, item.size, item.DetailTruncated = clipEventToLimitSize(item.Event, maxTraceItemsBytes-window.pageBytes, item.DetailTruncated)
				window.truncated = window.truncated || item.DetailTruncated
				window.pageBytes += item.size
			}
			return
		}
		if event.Name == "" {
			return
		}
	}
	if canMerge(window.items, event) {
		last := &window.items[len(window.items)-1]
		window.pageBytes -= last.size
		last.Text += event.Text
		last.Models = mergeTraceModels(last.Models, event.Models)
		var clipped bool
		last.Event, _, clipped = clipEventSize(last.Event, false)
		last.Event, last.size, clipped = clipEventToLimitSize(last.Event, maxTraceItemsBytes-window.pageBytes, clipped)
		last.SummaryTruncated = last.SummaryTruncated || clipped
		window.truncated = window.truncated || clipped
		window.pageBytes += last.size
		return
	}
	var clipped bool
	event.Event, event.size, clipped = clipEventSize(event.Event, false)
	if event.Type == "tool" {
		event.DetailTruncated = event.DetailTruncated || clipped
	} else {
		event.SummaryTruncated = event.SummaryTruncated || clipped
	}
	window.truncated = window.truncated || clipped
	for len(window.items) >= window.limit || (len(window.items) > 0 && window.pageBytes+event.size > maxTraceItemsBytes) {
		window.dropFront()
	}
	window.items = append(window.items, event)
	window.starts = append(window.starts, event.lineStart)
	window.pageBytes += event.size
}

// dropFront forgets the oldest item. The boundary turn head is the newest one
// dropped; a prepended window may still drop records that are older than a head
// its own window already lost, so the offsets have to decide.
func (window *traceWindow) dropFront() {
	if len(window.items) == 0 {
		return
	}
	window.older = true
	if turnHead(window.items[0].Type) && (window.orphan == nil || window.items[0].lineStart >= window.orphan.lineStart) {
		copy := window.items[0]
		window.orphan = &copy
	}
	window.pageBytes -= window.items[0].size
	window.items = window.items[1:]
	window.starts = window.starts[1:]
}

// traceParseChunk is the unit workers claim. Records differ enormously in
// cost (a screenshot is scanned, a text result is decoded), so fixed byte
// ranges balance poorly; small chunks let an idle core take the next one.
const traceParseChunk = 128 << 10

// parseRegion parses every record of data, which begins at absolute offset
// base. Records are line-local, so a large region is split at line boundaries
// and parsed on several cores; the result keeps the records in file order.
func parseRegion(data []byte, base int, parse traceParser) ([]parsedEvent, bool) {
	if len(data) < traceParallelMinBytes {
		return parseRegionSpan(data, base, parse)
	}
	workers := min(runtime.GOMAXPROCS(0), traceParallelWorkers)
	bounds := chunkBounds(data, workers)
	if len(bounds) <= 2 {
		return parseRegionSpan(data, base, parse)
	}
	parts := make([][]parsedEvent, len(bounds)-1)
	skips := make([]bool, len(parts))
	var next atomic.Int64
	var wait sync.WaitGroup
	for range min(workers, len(parts)) {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= len(parts) {
					return
				}
				parts[i], skips[i] = parseRegionSpan(data[bounds[i]:bounds[i+1]], base+bounds[i], parse)
			}
		}()
	}
	wait.Wait()
	total, skipped := 0, false
	for i, part := range parts {
		total += len(part)
		skipped = skipped || skips[i]
	}
	events := make([]parsedEvent, 0, total)
	for _, part := range parts {
		events = append(events, part...)
	}
	return events, skipped
}

// chunkBounds divides data into line-aligned ranges of about traceParseChunk
// bytes. A line counts whole, so one enormous record still gets a boundary
// after it and the records behind it can be parsed alongside it.
func chunkBounds(data []byte, workers int) []int {
	chunks := len(data) / traceParseChunk
	if chunks < workers {
		chunks = workers
	}
	if chunks > 256 {
		chunks = 256
	}
	bounds := make([]int, 0, chunks+1)
	bounds = append(bounds, 0)
	target := len(data) / chunks
	pos := 0
	for len(bounds) <= chunks && pos < len(data) {
		newline := bytes.IndexByte(data[pos:], '\n')
		if newline < 0 {
			break
		}
		pos += newline + 1
		if pos >= len(data) {
			break
		}
		if pos >= target*len(bounds) {
			bounds = append(bounds, pos)
		}
	}
	return append(bounds, len(data))
}

func parseRegionSpan(data []byte, base int, parse traceParser) ([]parsedEvent, bool) {
	var events []parsedEvent
	skipped := false
	forEachLineBytes(data, maxTraceLine, func(line []byte, lineSize int, oversized bool) bool {
		lineStart := base
		base += lineSize
		if oversized {
			skipped = true
			return true
		}
		for ordinal, event := range parse(line) {
			event.lineStart = lineStart
			event.sourceOrdinal = ordinal
			events = append(events, event)
		}
		return true
	})
	return events, skipped
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
		for len(window.items) > 1 && window.pageBytes+window.orphan.size > maxTraceItemsBytes {
			window.pageBytes -= window.items[0].size
			window.items = window.items[1:]
			window.starts = window.starts[1:]
		}
	}
	page := TracePage{
		Items: make([]Event, 0, len(window.items)+1), Truncated: window.truncated || window.skipped || limited,
		SummaryTruncated: window.skipped || limited,
	}
	if window.orphan != nil && len(window.items) < window.limit && (len(window.items) == 0 || !turnHead(window.items[0].Type)) && window.pageBytes+window.orphan.size <= maxTraceItemsBytes {
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
