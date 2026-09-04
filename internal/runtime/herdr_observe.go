package runtime

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type herdrAgentSessionWire struct {
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

type herdrPaneWire struct {
	PaneID       string                 `json:"pane_id"`
	WorkspaceID  string                 `json:"workspace_id"`
	TabID        string                 `json:"tab_id"`
	Cwd          string                 `json:"cwd"`
	Agent        string                 `json:"agent"`
	AgentStatus  string                 `json:"agent_status"`
	Label        *string                `json:"label"`
	Title        string                 `json:"terminal_title_stripped"`
	AgentSession *herdrAgentSessionWire `json:"agent_session"`
	Scroll       *struct {
		OffsetFromBottom int `json:"offset_from_bottom"`
		ViewportRows     int `json:"viewport_rows"`
	} `json:"scroll"`
}

type herdrWorkspaceWire struct {
	WorkspaceID string `json:"workspace_id"`
	Number      int    `json:"number"`
	Label       string `json:"label"`
	Cwd         string `json:"cwd"`
	AgentStatus string `json:"agent_status"`
}

type herdrTabWire struct {
	TabID       string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
}

type herdrSnapWire struct {
	Type     string `json:"type"`
	Snapshot struct {
		Version            string               `json:"version"`
		Protocol           int                  `json:"protocol"`
		FocusedWorkspaceID string               `json:"focused_workspace_id"`
		FocusedTabID       string               `json:"focused_tab_id"`
		FocusedPaneID      string               `json:"focused_pane_id"`
		Workspaces         []herdrWorkspaceWire `json:"workspaces"`
		Tabs               []herdrTabWire       `json:"tabs"`
		Panes              []herdrPaneWire      `json:"panes"`
		Layouts            []herdrLayoutWire    `json:"layouts"`
	} `json:"snapshot"`
}

func (h *Herdr) snapshot(ctx context.Context, session SessionRef) (Snapshot, error) {
	raw, err := h.call(ctx, session, "session.snapshot", map[string]any{}, false)
	if err != nil {
		return Snapshot{}, err
	}
	var wire herdrSnapWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Snapshot{}, responseFault("session.snapshot", "invalid Herdr session snapshot", err, false)
	}
	if wire.Type != "session_snapshot" || wire.Snapshot.Version == "" || wire.Snapshot.Protocol <= 0 {
		return Snapshot{}, responseFault("session.snapshot", "invalid Herdr session snapshot", nil, false)
	}
	s := wire.Snapshot
	if !validOptionalResourceID(s.FocusedWorkspaceID) || !validOptionalResourceID(s.FocusedTabID) || !validOptionalResourceID(s.FocusedPaneID) {
		return Snapshot{}, responseFault("session.snapshot", "invalid Herdr resource id", nil, false)
	}
	for _, workspace := range s.Workspaces {
		if !validResourceID.MatchString(workspace.WorkspaceID) {
			return Snapshot{}, responseFault("session.snapshot", "invalid Herdr workspace id", nil, false)
		}
	}
	for _, tab := range s.Tabs {
		if !validResourceID.MatchString(tab.TabID) || !validResourceID.MatchString(tab.WorkspaceID) {
			return Snapshot{}, responseFault("session.snapshot", "invalid Herdr tab id", nil, false)
		}
	}
	for _, pane := range s.Panes {
		if !validResourceID.MatchString(pane.PaneID) || !validResourceID.MatchString(pane.WorkspaceID) || !validResourceID.MatchString(pane.TabID) {
			return Snapshot{}, responseFault("session.snapshot", "invalid Herdr pane id", nil, false)
		}
	}
	out := Snapshot{
		HerdrVersion: s.Version, HerdrProtocol: s.Protocol, CapturedAt: time.Now().Unix(),
		Focused: map[string]string{"workspace_id": s.FocusedWorkspaceID, "tab_id": s.FocusedTabID, "pane_id": s.FocusedPaneID},
	}
	if session.Name != "" {
		name := session.Name
		out.Session = &name
	}
	for _, workspace := range s.Workspaces {
		out.Workspaces = append(out.Workspaces, Workspace{
			WorkspaceID: workspace.WorkspaceID, Number: workspace.Number, Label: workspace.Label,
			Cwd: workspace.Cwd, AgentStatus: workspace.AgentStatus,
		})
	}
	for _, tab := range s.Tabs {
		out.Tabs = append(out.Tabs, Tab{TabID: tab.TabID, WorkspaceID: tab.WorkspaceID, Label: tab.Label})
	}
	for _, pane := range s.Panes {
		out.Panes = append(out.Panes, normalizePane(pane))
	}
	out.Layouts = normalizeLayouts(s.Layouts)
	return out, nil
}

func normalizePane(p herdrPaneWire) Pane {
	out := Pane{
		PaneID: p.PaneID, WorkspaceID: p.WorkspaceID, TabID: p.TabID, Cwd: p.Cwd,
		Agent: p.Agent, AgentStatus: p.AgentStatus, Label: p.Label, Scroll: p.Scroll,
		TerminalTitle: strings.TrimSpace(p.Title),
	}
	if session := p.AgentSession; session != nil && session.Source != "" && session.Agent != "" && session.Value != "" && (session.Kind == "id" || session.Kind == "path") {
		out.AgentSession = &AgentSessionRef{Source: session.Source, Agent: session.Agent, Kind: session.Kind, Value: session.Value}
		out.HistoryAvailable = true
	}
	return out
}

type agentManifestWire struct {
	Agent string `json:"agent"`
}

func (h *Herdr) agentKinds(ctx context.Context, session SessionRef) ([]AgentKind, error) {
	raw, err := h.call(ctx, session, "server.agent_manifests", map[string]any{}, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Type      string              `json:"type"`
		Manifests []agentManifestWire `json:"manifests"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Type != "agent_manifest_status" {
		return nil, responseFault("server.agent_manifests", "invalid Herdr agent manifest response", err, false)
	}
	seen := make(map[string]struct{}, len(response.Manifests))
	for _, manifest := range response.Manifests {
		if manifest.Agent != "" {
			seen[manifest.Agent] = struct{}{}
		}
	}
	values := make([]string, 0, len(seen))
	for kind := range seen {
		values = append(values, kind)
	}
	sort.Strings(values)
	kinds := make([]AgentKind, 0, len(values))
	for _, kind := range values {
		kinds = append(kinds, AgentKind{Kind: kind})
	}
	return kinds, nil
}

func capabilities(protocol int) map[Feature]Capability {
	features := []Feature{
		FeatureSnapshot, FeaturePaneRead, FeaturePaneInput, FeatureRename, FeatureClose,
		FeatureCreateConversation, FeatureCreateTab, FeatureSplitPane, FeaturePromptAgent,
		FeatureWorktreeList, FeatureWorktreeCreate, FeatureWorktreeOpen,
		FeatureLayoutResize, FeatureLayoutSwap, FeatureLayoutZoom, FeatureHistory,
	}
	out := make(map[Feature]Capability, len(features))
	for _, feature := range features {
		out[feature] = Capability{Reason: "unsupported by live runtime"}
	}
	if protocol > 0 {
		for _, feature := range []Feature{FeatureSnapshot, FeaturePaneRead, FeaturePaneInput, FeatureRename, FeatureClose} {
			out[feature] = Capability{Available: true}
		}
	}
	if protocol >= 19 {
		for _, feature := range []Feature{
			FeatureCreateConversation, FeatureCreateTab, FeatureSplitPane, FeaturePromptAgent, FeatureWorktreeList,
			FeatureWorktreeCreate, FeatureWorktreeOpen, FeatureLayoutResize, FeatureLayoutSwap, FeatureLayoutZoom,
		} {
			out[feature] = Capability{Available: true}
		}
	}
	out[FeatureHistory] = Capability{Reason: "history reader is not configured"}
	return out
}

func (h *Herdr) Describe(ctx context.Context, session SessionRef) (Descriptor, error) {
	snapshot, err := h.snapshot(ctx, session)
	if err != nil {
		return Descriptor{}, err
	}
	descriptor := Descriptor{Runtime: "herdr", Version: snapshot.HerdrVersion, Protocol: snapshot.HerdrProtocol}
	kinds, manifestErr := h.agentKinds(ctx, session)
	if manifestErr != nil {
		descriptor.Warnings = append(descriptor.Warnings, manifestErr.Error())
	} else {
		descriptor.AgentKinds = kinds
	}
	descriptor.Capabilities = capabilities(snapshot.HerdrProtocol)
	return descriptor, nil
}

func (h *Herdr) Observe(ctx context.Context, session SessionRef, query Query) (View, error) {
	switch value := query.(type) {
	case SnapshotQuery:
		snapshot, err := h.snapshot(ctx, session)
		if err != nil {
			return nil, err
		}
		return SnapshotView{Snapshot: snapshot}, nil
	case PaneReadQuery:
		return h.readPane(ctx, session, value)
	case WorktreeListQuery:
		if err := h.requireFeature(ctx, session, FeatureWorktreeList, "worktree.list"); err != nil {
			return nil, err
		}
		return h.listWorktrees(ctx, session, value)
	case HistoryQuery:
		return nil, unsupported("history", "history reader is not configured")
	default:
		return nil, unsupported("observe", "unknown runtime query")
	}
}

func (h *Herdr) readPane(ctx context.Context, session SessionRef, query PaneReadQuery) (View, error) {
	if query.PaneID == "" {
		return nil, invalidFault("pane.read", "pane id is required")
	}
	if query.Source == "" {
		query.Source = SourceVisible
	}
	if query.Format == "" {
		query.Format = FormatText
	}
	if !validPaneReadSource(query.Source) || (query.Format != FormatText && query.Format != FormatANSI) || query.Lines < 0 || query.Lines > 4096 {
		return nil, invalidFault("pane.read", "invalid pane read options")
	}
	raw, err := h.call(ctx, session, "pane.read", map[string]any{
		"pane_id": query.PaneID, "source": query.Source, "format": query.Format, "lines": query.Lines,
	}, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Type string `json:"type"`
		Read struct {
			Text      string `json:"text"`
			Truncated bool   `json:"truncated"`
		} `json:"read"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Type != "pane_read" {
		return nil, responseFault("pane.read", "invalid Herdr pane read response", err, false)
	}
	return PaneReadView{Text: response.Read.Text, Truncated: response.Read.Truncated}, nil
}

func validPaneReadSource(source string) bool {
	return source == SourceVisible || source == SourceRecent || source == SourceRecentUnwrapped
}

func (h *Herdr) listWorktrees(ctx context.Context, session SessionRef, query WorktreeListQuery) (View, error) {
	raw, err := h.call(ctx, session, "worktree.list", map[string]any{
		"workspace_id": optionalString(query.WorkspaceID), "cwd": optionalString(query.CWD),
	}, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Type   string `json:"type"`
		Source struct {
			RepoKey           string  `json:"repo_key"`
			RepoName          string  `json:"repo_name"`
			RepoRoot          string  `json:"repo_root"`
			SourcePath        string  `json:"source_checkout_path"`
			SourceWorkspaceID *string `json:"source_workspace_id"`
		} `json:"source"`
		Worktrees []struct {
			Path            string  `json:"path"`
			Branch          *string `json:"branch"`
			Label           string  `json:"label"`
			OpenWorkspaceID *string `json:"open_workspace_id"`
			Bare            bool    `json:"is_bare"`
			Detached        bool    `json:"is_detached"`
			Prunable        bool    `json:"is_prunable"`
			Linked          bool    `json:"is_linked_worktree"`
		} `json:"worktrees"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Type != "worktree_list" {
		return nil, responseFault("worktree.list", "invalid Herdr worktree list response", err, false)
	}
	if !validOptionalResourceID(pointerValue(response.Source.SourceWorkspaceID)) {
		return nil, responseFault("worktree.list", "invalid Herdr worktree source", nil, false)
	}
	for _, item := range response.Worktrees {
		if item.Path == "" || !filepath.IsAbs(item.Path) || utf8.RuneCountInString(item.Path) > 4096 ||
			(item.Branch != nil && (*item.Branch == "" || utf8.RuneCountInString(*item.Branch) > 512)) ||
			utf8.RuneCountInString(item.Label) > 256 || !validOptionalResourceID(pointerValue(item.OpenWorkspaceID)) {
			return nil, responseFault("worktree.list", "invalid Herdr worktree item", nil, false)
		}
	}
	view := WorktreeListView{Source: WorktreeSource{
		RepositoryKey: response.Source.RepoKey, RepositoryName: response.Source.RepoName,
		RepositoryRoot: response.Source.RepoRoot, SourcePath: response.Source.SourcePath,
	}}
	if response.Source.SourceWorkspaceID != nil {
		view.Source.SourceWorkspace = *response.Source.SourceWorkspaceID
	}
	for _, item := range response.Worktrees {
		view.Worktrees = append(view.Worktrees, Worktree{
			Path: item.Path, Branch: item.Branch, Label: item.Label, OpenWorkspaceID: item.OpenWorkspaceID,
			Bare: item.Bare, Detached: item.Detached, Prunable: item.Prunable, Linked: item.Linked,
		})
	}
	return view, nil
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
