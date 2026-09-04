package journal

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
)

const (
	traceInitialReadBytes = 512 << 10
	traceMaxReadChunk     = 4 << 20
	maxTraceCacheEntries  = 32
)

type traceParser func([]byte) []parsedEvent

type traceReadStats struct {
	FileBytes    int64
	Modified     int64
	ScannedBytes int
}

type traceCacheKey struct {
	path  string
	limit int
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
	orphan    *parsedEvent
}

func (r *Reader) ReadTrace(ref Ref, cursor *string, limit int) (TracePage, error) {
	if !r.Supports(ref) {
		return TracePage{}, ErrUnavailable
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		return TracePage{}, errors.New("invalid history limit")
	}
	end, err := decodeCursor(ref, cursor)
	if err != nil {
		return TracePage{}, err
	}
	path, err := r.transcriptPath(ref, true)
	if err != nil {
		return TracePage{}, err
	}
	parse := traceParser(parseGrokTrace)
	switch ref.Agent {
	case "codex":
		parse = parseCodexTrace
	case "claude":
		parse = parseClaudeTrace
	}
	if cursor == nil {
		if page, ok := r.cachedTracePage(path, limit); ok {
			return page, nil
		}
	}
	page, stats, err := readTracePage(path, ref, end, limit, parse)
	if err == nil && cursor == nil {
		r.cacheTracePage(path, limit, stats, page)
	}
	return page, err
}

func (r *Reader) ReadTraceSummary(ref Ref, cursor *string, limit int) (TraceSummaryPage, error) {
	page, err := r.ReadTrace(ref, cursor, limit)
	if err != nil {
		return TraceSummaryPage{}, err
	}
	items := make([]TraceSummaryItem, 0, len(page.Items))
	for _, item := range page.Items {
		if item.Type == "tool" {
			items = append(items, TraceSummaryItem{
				Type: item.Type, Name: item.Name, State: traceToolState(item), DetailRef: item.DetailRef,
			})
			continue
		}
		items = append(items, TraceSummaryItem{Type: item.Type, Text: item.Text})
	}
	return TraceSummaryPage{Items: items, NextCursor: page.NextCursor, Truncated: page.SummaryTruncated}, nil
}

func (r *Reader) cachedTracePage(path string, limit int) (TracePage, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return TracePage{}, false
	}
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	entry, ok := r.traceCache[traceCacheKey{path: path, limit: limit}]
	if !ok || entry.size != info.Size() || entry.modified != info.ModTime().UnixNano() {
		return TracePage{}, false
	}
	return cloneTracePage(entry.page), true
}

func (r *Reader) cacheTracePage(path string, limit int, stats traceReadStats, page TracePage) {
	info, err := os.Stat(path)
	if err != nil || info.Size() != stats.FileBytes || info.ModTime().UnixNano() != stats.Modified {
		return
	}
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	if r.traceCache == nil || len(r.traceCache) >= maxTraceCacheEntries {
		r.traceCache = make(map[traceCacheKey]traceCacheEntry)
	}
	r.traceCache[traceCacheKey{path: path, limit: limit}] = traceCacheEntry{
		size: info.Size(), modified: info.ModTime().UnixNano(), page: cloneTracePage(page),
	}
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

func readTracePage(path string, ref Ref, end, limit int, parse traceParser) (TracePage, traceReadStats, error) {
	file, err := os.Open(path)
	if err != nil {
		return TracePage{}, traceReadStats{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return TracePage{}, traceReadStats{}, err
	}
	stats := traceReadStats{FileBytes: info.Size(), Modified: info.ModTime().UnixNano()}
	if end <= 0 || int64(end) > info.Size() {
		end = int(info.Size())
	}
	start := end
	chunkSize := traceInitialReadBytes
	var data []byte
	var window traceWindow
	alignedStart := end
	limited := false

	for {
		remainingBudget := maxScanBytes - stats.ScannedBytes
		if start == 0 || remainingBudget <= 0 {
			limited = start > 0
			break
		}
		readBytes := min(chunkSize, start, remainingBudget)
		nextStart := start - readBytes
		chunk := make([]byte, readBytes)
		read, err := file.ReadAt(chunk, int64(nextStart))
		if err != nil && err != io.EOF {
			return TracePage{}, stats, err
		}
		if read != readBytes {
			return TracePage{}, stats, io.ErrUnexpectedEOF
		}
		data = append(chunk, data...)
		stats.ScannedBytes += readBytes
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
		window, err = parseTraceWindow(view, alignedStart, limit, parse)
		if err != nil {
			return TracePage{}, stats, err
		}
		if traceWindowComplete(window, start == 0) {
			break
		}
		chunkSize = min(chunkSize*2, traceMaxReadChunk)
	}

	page := window.page(ref, alignedStart, limited)
	return page, stats, nil
}

func parseTraceWindow(data []byte, base, limit int, parse traceParser) (traceWindow, error) {
	window := traceWindow{items: make([]parsedEvent, 0, limit), starts: make([]int, 0, limit), limit: limit}
	dropFront := func() {
		if len(window.items) == 0 {
			return
		}
		window.older = true
		if window.items[0].Type == "user" {
			copy := window.items[0]
			window.orphan = &copy
		}
		window.pageBytes -= eventSize(window.items[0].Event)
		window.items = window.items[1:]
		window.starts = window.starts[1:]
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64<<10), maxTranscriptLine)
	position := base
	for scanner.Scan() {
		lineStart := position
		position += len(scanner.Bytes()) + 1
		for ordinal, event := range parse(scanner.Bytes()) {
			event.lineStart = lineStart
			event.sourceOrdinal = ordinal
			if event.outputOnly {
				if item, attached := outputTarget(window.items, event.call, event.Output); attached {
					if item != nil {
						window.pageBytes -= eventSize(item.Event)
						item.Output = event.Output
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
	}
	return window, scanner.Err()
}

func traceWindowComplete(window traceWindow, atStart bool) bool {
	if atStart {
		return true
	}
	if len(window.items) == 0 {
		return false
	}
	return window.items[0].Type == "user" || window.orphan != nil || window.older
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
		Items: make([]Event, 0, len(window.items)+1), Truncated: window.truncated || limited, SummaryTruncated: limited,
	}
	if window.orphan != nil && len(window.items) < window.limit && (len(window.items) == 0 || window.items[0].Type != "user") && window.pageBytes+eventSize(window.orphan.Event) <= maxTraceItemsBytes {
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
