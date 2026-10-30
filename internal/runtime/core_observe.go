package runtime

import (
	"context"
	"time"
)

func (c *Core) Observe(ctx context.Context, session SessionRef, query Query) (View, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	if err := coreDefaultSession("observe", session); err != nil {
		return nil, err
	}
	switch value := query.(type) {
	case SnapshotQuery:
		return c.coreSnapshot(ctx)
	case PaneReadQuery:
		return c.coreReadPane(ctx, value)
	case HistoryQuery:
		return nil, unsupported("history", "the terminal core has no transcript history")
	default:
		return nil, unsupported("observe", "unknown runtime query")
	}
}

func (c *Core) coreSnapshot(ctx context.Context) (View, error) {
	conn, hello, err := c.connection(ctx)
	if err != nil {
		return nil, err
	}
	if !hello.has("terminal.list") {
		return nil, unsupported("snapshot", "snapshot is unsupported by the terminal core")
	}
	var list coreListResult
	if err := conn.Call(ctx, "terminal.list", map[string]any{"all": false}, &list); err != nil {
		return nil, c.endCall(conn, "snapshot", err, false, false)
	}
	if list.Terminals == nil {
		return nil, c.endCall(conn, "snapshot", coreProtocol("terminal.list", "terminal list is missing"), false, false)
	}
	terminals, err := coreLiveTerminals(*list.Terminals)
	if err != nil {
		return nil, c.endCall(conn, "snapshot", err, false, false)
	}
	return SnapshotView{Snapshot: projectCoreSnapshot(hello, terminals, time.Now().Unix())}, nil
}

func (c *Core) coreReadPane(ctx context.Context, query PaneReadQuery) (View, error) {
	if query.PaneID == "" {
		return nil, invalidFault("pane.read", "pane id is required")
	}
	terminal, err := decodeCorePaneID(query.PaneID)
	if err != nil {
		return nil, err
	}
	if query.Source == "" {
		query.Source = SourceVisible
	}
	if query.Format == "" {
		query.Format = FormatText
	}
	if !validPaneReadSource(query.Source) || (query.Format != FormatText && query.Format != FormatANSI) {
		return nil, invalidFault("pane.read", "invalid pane read options")
	}
	lines := query.Lines
	if query.Source == SourceVisible {
		lines = 0
	}
	if lines < 0 {
		lines = 0
	}
	if lines > 4096 {
		lines = 4096
	}
	conn, hello, err := c.connection(ctx)
	if err != nil {
		return nil, err
	}
	if !hello.has("terminal.read") {
		return nil, unsupported("pane.read", "pane read is unsupported by the terminal core")
	}
	var read coreReadResult
	if err := conn.Call(ctx, "terminal.read", map[string]any{"terminal": terminal, "lines": lines}, &read); err != nil {
		return nil, c.endCall(conn, "pane.read", err, false, false)
	}
	if read.How != "screen" && read.How != "history" && read.How != "stitched" {
		return nil, c.endCall(conn, "pane.read", coreProtocol("terminal.read", "invalid terminal read"), false, false)
	}
	// Core only returns plain text. ANSI is a documented degradation: the
	// PWA's renderer accepts the same text, so it is not a fault.
	return PaneReadView{Text: read.Text, Truncated: !read.Complete}, nil
}
