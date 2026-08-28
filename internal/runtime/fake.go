package runtime

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Fake is an in-memory Harness adapter. It models Pairfob behavior rather than
// exposing Herdr wire calls to tests.
type Fake struct {
	mu         sync.Mutex
	Panes      map[string]*PaneState
	Snap       Snapshot
	Worktrees  []Worktree
	AgentKinds []AgentKind
	next       int
}

type PaneState struct {
	Text     string
	EchoOff  bool
	InputBox string
	Keys     []string
	Texts    []string
}

func NewFake() *Fake {
	// Agents box their dialogs and print a key hint underneath. Keep the demo
	// buffer in that shape so prompt lifting is exercised the way it ships.
	p := &PaneState{Text: "● Read README.md (18 lines)\n" +
		"  ⎿  # Pairfob\n" +
		"\n" +
		"╭──────────────────────────────────────────────────╮\n" +
		"│ Edit file                                        │\n" +
		"│                                                  │\n" +
		"│ Do you want to make this edit to README.md?      │\n" +
		"│ ❯ 1. Yes                                         │\n" +
		"│   2. Yes, allow all edits this session           │\n" +
		"│   3. No, and tell Claude what to do differently  │\n" +
		"╰──────────────────────────────────────────────────╯\n" +
		"\n" +
		"中文注释：字形不能叠到下一行 永字國國 gÅqyp\n" +
		"----+----1----+----2----+----3----+----4----+----5----+----6----+----7----+----8\n" +
		"  esc to interrupt · ? for shortcuts\n"}
	return &Fake{
		Panes: map[string]*PaneState{"w0:p1": p},
		Snap: Snapshot{
			HerdrVersion: "0.8.0-fake", HerdrProtocol: 19, CapturedAt: time.Now().Unix(),
			Focused:    map[string]string{"workspace_id": "w0", "tab_id": "w0:t1", "pane_id": "w0:p1"},
			Workspaces: []Workspace{{WorkspaceID: "w0", Number: 1, Label: "pairfob", Cwd: "/tmp/pairfob", AgentStatus: "blocked"}},
			Tabs:       []Tab{{TabID: "w0:t1", WorkspaceID: "w0", Label: "main"}},
			Panes: []Pane{{
				PaneID: "w0:p1", WorkspaceID: "w0", TabID: "w0:t1", Cwd: "/tmp/pairfob",
				Agent: "claude", AgentStatus: "blocked",
			}},
		},
		AgentKinds: []AgentKind{{Kind: "claude"}, {Kind: "codex"}, {Kind: "grok"}},
		next:       2,
	}
}

func (f *Fake) Describe(ctx context.Context, _ SessionRef) (Descriptor, error) {
	if err := contextFault("describe", ctx.Err(), false); err != nil {
		return Descriptor{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	kinds := append([]AgentKind(nil), f.AgentKinds...)
	return Descriptor{
		Runtime: "fake", Version: f.Snap.HerdrVersion, Protocol: f.Snap.HerdrProtocol,
		Capabilities: capabilities(f.Snap.HerdrProtocol), AgentKinds: kinds,
	}, nil
}

func (f *Fake) Observe(ctx context.Context, session SessionRef, query Query) (View, error) {
	if err := contextFault("observe", ctx.Err(), false); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch value := query.(type) {
	case SnapshotQuery:
		snapshot := f.snapshotLocked(session)
		return SnapshotView{Snapshot: snapshot}, nil
	case PaneReadQuery:
		if value.Source == "" {
			value.Source = SourceVisible
		}
		if value.Format == "" {
			value.Format = FormatText
		}
		if !validPaneReadSource(value.Source) || (value.Format != FormatText && value.Format != FormatANSI) || value.Lines < 0 || value.Lines > 4096 {
			return nil, invalidFault("pane.read", "invalid pane read options")
		}
		pane := f.Panes[value.PaneID]
		if pane == nil {
			return nil, notFoundFault("pane.read", EntityPane, value.PaneID)
		}
		text := pane.Text
		if pane.InputBox != "" && !pane.EchoOff && !strings.Contains(text, pane.InputBox) {
			text = strings.TrimRight(text, "\n") + pane.InputBox + "\n"
		}
		if value.Lines == 0 {
			return PaneReadView{Truncated: text != ""}, nil
		}
		if value.Source == SourceVisible {
			return PaneReadView{Text: text}, nil
		}
		text, truncated := recentLines(text, value.Lines)
		return PaneReadView{Text: text, Truncated: truncated}, nil
	case WorktreeListQuery:
		return WorktreeListView{
			Source:    WorktreeSource{RepositoryKey: "fake", RepositoryName: "fake", RepositoryRoot: "/tmp/fake", SourcePath: value.CWD, SourceWorkspace: value.WorkspaceID},
			Worktrees: append([]Worktree(nil), f.Worktrees...),
		}, nil
	case HistoryQuery:
		return nil, unsupported("history", "history reader is not configured")
	default:
		return nil, unsupported("observe", "unknown runtime query")
	}
}

func recentLines(text string, lines int) (string, bool) {
	trimmed := strings.TrimSuffix(text, "\n")
	if trimmed == "" {
		return "", false
	}
	rows := strings.Split(trimmed, "\n")
	if len(rows) <= lines {
		return text, false
	}
	return strings.Join(rows[len(rows)-lines:], "\n") + "\n", true
}

func (f *Fake) Execute(ctx context.Context, session SessionRef, operationID string, command Command) (Receipt, error) {
	if operationID == "" || len(operationID) > 128 || !utf8.ValidString(operationID) {
		return notApplied(operationID, invalidFault("execute", "valid operation id is required"))
	}
	if err := contextFault("execute", ctx.Err(), true); err != nil {
		return receiptForError(operationID, err), err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = session
	switch value := command.(type) {
	case SendTextCommand:
		pane := f.Panes[value.PaneID]
		if pane == nil {
			return notApplied(operationID, notFoundFault("pane.send_text", EntityPane, value.PaneID))
		}
		pane.Texts = append(pane.Texts, value.Text)
		if !pane.EchoOff {
			pane.InputBox += value.Text
		}
		return updatedReceipt(operationID, EntityPane, value.PaneID), nil
	case SendKeysCommand:
		pane := f.Panes[value.PaneID]
		if pane == nil {
			return notApplied(operationID, notFoundFault("pane.send_keys", EntityPane, value.PaneID))
		}
		if len(value.Keys) == 0 {
			return notApplied(operationID, invalidFault("pane.send_keys", "keys are required"))
		}
		pane.Keys = append(pane.Keys, value.Keys...)
		for _, key := range value.Keys {
			if strings.EqualFold(key, "Enter") {
				pane.Text += pane.InputBox + "\nworking...\n"
				pane.InputBox = ""
				f.setPaneStatusLocked(value.PaneID, "working")
			}
		}
		return updatedReceipt(operationID, EntityPane, value.PaneID), nil
	case RenamePaneCommand:
		if f.Panes[value.PaneID] == nil {
			return notApplied(operationID, notFoundFault("pane.rename", EntityPane, value.PaneID))
		}
		for i := range f.Snap.Panes {
			if f.Snap.Panes[i].PaneID == value.PaneID {
				f.Snap.Panes[i].Label = cloneString(value.Label)
				return updatedReceipt(operationID, EntityPane, value.PaneID), nil
			}
		}
	case RenameTabCommand:
		for i := range f.Snap.Tabs {
			if f.Snap.Tabs[i].TabID == value.TabID {
				if value.Label == "" {
					return notApplied(operationID, invalidFault("tab.rename", "label is required"))
				}
				f.Snap.Tabs[i].Label = value.Label
				return updatedReceipt(operationID, EntityTab, value.TabID), nil
			}
		}
		return notApplied(operationID, notFoundFault("tab.rename", EntityTab, value.TabID))
	case RenameWorkspaceCommand:
		for i := range f.Snap.Workspaces {
			if f.Snap.Workspaces[i].WorkspaceID == value.WorkspaceID {
				if value.Label == "" {
					return notApplied(operationID, invalidFault("workspace.rename", "label is required"))
				}
				f.Snap.Workspaces[i].Label = value.Label
				return updatedReceipt(operationID, EntityWorkspace, value.WorkspaceID), nil
			}
		}
		return notApplied(operationID, notFoundFault("workspace.rename", EntityWorkspace, value.WorkspaceID))
	case ClosePaneCommand:
		return f.closePaneLocked(operationID, value.PaneID)
	case CloseTabCommand:
		return f.closeTabLocked(operationID, value.TabID)
	case CreateConversationCommand:
		return f.createConversationLocked(operationID, value)
	case CreateTabCommand:
		return f.createTabLocked(operationID, value)
	case SplitPaneCommand:
		return f.splitPaneLocked(operationID, value)
	case PromptAgentCommand:
		for i := range f.Snap.Panes {
			pane := &f.Snap.Panes[i]
			if pane.PaneID == value.Target || pane.Agent == value.Target {
				if value.Text == "" {
					return notApplied(operationID, invalidFault("agent.prompt", "prompt is required"))
				}
				f.Panes[pane.PaneID].Texts = append(f.Panes[pane.PaneID].Texts, value.Text)
				pane.AgentStatus = "working"
				return updatedReceipt(operationID, EntityAgent, value.Target), nil
			}
		}
		return notApplied(operationID, notFoundFault("agent.prompt", EntityAgent, value.Target))
	case WorktreeCreateCommand:
		path := value.Path
		if path == "" {
			path = fmt.Sprintf("/tmp/worktree-%d", f.next)
		}
		branch := cloneNonEmpty(value.Branch)
		f.Worktrees = append(f.Worktrees, Worktree{Path: path, Branch: branch, Label: value.Label, Linked: true})
		return f.openFakeWorktreeLocked(operationID, len(f.Worktrees)-1)
	case WorktreeOpenCommand:
		for i := range f.Worktrees {
			if (value.Path != "" && f.Worktrees[i].Path == value.Path) || (value.Branch != "" && f.Worktrees[i].Branch != nil && *f.Worktrees[i].Branch == value.Branch) {
				if f.Worktrees[i].OpenWorkspaceID != nil {
					refs := []EntityRef{{Kind: EntityWorkspace, ID: *f.Worktrees[i].OpenWorkspaceID}, {Kind: EntityWorktree, ID: f.Worktrees[i].Path}}
					for _, tab := range f.Snap.Tabs {
						if tab.WorkspaceID == *f.Worktrees[i].OpenWorkspaceID {
							refs = append(refs, EntityRef{Kind: EntityTab, ID: tab.TabID})
							break
						}
					}
					for _, pane := range f.Snap.Panes {
						if pane.WorkspaceID == *f.Worktrees[i].OpenWorkspaceID {
							refs = append(refs, EntityRef{Kind: EntityPane, ID: pane.PaneID})
							break
						}
					}
					return Receipt{OperationID: operationID, Outcome: OutcomeNoop, Created: refs}, nil
				}
				return f.openFakeWorktreeLocked(operationID, i)
			}
		}
		return notApplied(operationID, notFoundFault("worktree.open", EntityWorktree, value.Path))
	case ResizePaneCommand:
		if f.Panes[value.PaneID] == nil {
			return notApplied(operationID, notFoundFault("pane.resize", EntityPane, value.PaneID))
		}
		if !validPaneDirection(value.Direction) {
			return notApplied(operationID, invalidFault("pane.resize", "invalid direction"))
		}
		return updatedReceipt(operationID, EntityPane, value.PaneID), nil
	case SwapPaneCommand:
		if f.Panes[value.PaneID] == nil {
			return notApplied(operationID, notFoundFault("pane.swap", EntityPane, value.PaneID))
		}
		if !validPaneDirection(value.Direction) {
			return notApplied(operationID, invalidFault("pane.swap", "invalid direction"))
		}
		return updatedReceipt(operationID, EntityPane, value.PaneID), nil
	case ZoomPaneCommand:
		if f.Panes[value.PaneID] == nil {
			return notApplied(operationID, notFoundFault("pane.zoom", EntityPane, value.PaneID))
		}
		if value.Mode != ZoomToggle && value.Mode != ZoomOn && value.Mode != ZoomOff {
			return notApplied(operationID, invalidFault("pane.zoom", "invalid zoom mode"))
		}
		return updatedReceipt(operationID, EntityPane, value.PaneID), nil
	default:
		return notApplied(operationID, unsupported("execute", "unknown runtime command"))
	}
	return notApplied(operationID, &Fault{Code: CodeInternal, Operation: "execute", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "fake state is inconsistent"})
}

func (f *Fake) snapshotLocked(session SessionRef) Snapshot {
	snapshot := f.Snap
	snapshot.Focused = make(map[string]string, len(f.Snap.Focused))
	for key, value := range f.Snap.Focused {
		snapshot.Focused[key] = value
	}
	snapshot.Workspaces = append([]Workspace(nil), f.Snap.Workspaces...)
	snapshot.Tabs = append([]Tab(nil), f.Snap.Tabs...)
	snapshot.Panes = make([]Pane, len(f.Snap.Panes))
	for i, pane := range f.Snap.Panes {
		snapshot.Panes[i] = pane
		snapshot.Panes[i].Label = cloneString(pane.Label)
		if pane.AgentSession != nil {
			binding := *pane.AgentSession
			snapshot.Panes[i].AgentSession = &binding
		}
		if pane.Scroll != nil {
			scroll := *pane.Scroll
			snapshot.Panes[i].Scroll = &scroll
		}
	}
	if session.Name != "" {
		name := session.Name
		snapshot.Session = &name
	} else {
		snapshot.Session = nil
	}
	snapshot.CapturedAt = time.Now().Unix()
	return snapshot
}

func (f *Fake) setPaneStatusLocked(paneID, status string) {
	for i := range f.Snap.Panes {
		if f.Snap.Panes[i].PaneID == paneID {
			f.Snap.Panes[i].AgentStatus = status
			return
		}
	}
}

func (f *Fake) closePaneLocked(operationID, paneID string) (Receipt, error) {
	if f.Panes[paneID] == nil {
		return notApplied(operationID, notFoundFault("pane.close", EntityPane, paneID))
	}
	delete(f.Panes, paneID)
	for i := range f.Snap.Panes {
		if f.Snap.Panes[i].PaneID == paneID {
			f.Snap.Panes = append(f.Snap.Panes[:i], f.Snap.Panes[i+1:]...)
			return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Removed: []EntityRef{{Kind: EntityPane, ID: paneID}}}, nil
		}
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeNoop}, nil
}

func (f *Fake) closeTabLocked(operationID, tabID string) (Receipt, error) {
	found := false
	for i := range f.Snap.Tabs {
		if f.Snap.Tabs[i].TabID == tabID {
			f.Snap.Tabs = append(f.Snap.Tabs[:i], f.Snap.Tabs[i+1:]...)
			found = true
			break
		}
	}
	if !found {
		return notApplied(operationID, notFoundFault("tab.close", EntityTab, tabID))
	}
	panes := f.Snap.Panes[:0]
	removed := []EntityRef{{Kind: EntityTab, ID: tabID}}
	for _, pane := range f.Snap.Panes {
		if pane.TabID == tabID {
			delete(f.Panes, pane.PaneID)
			removed = append(removed, EntityRef{Kind: EntityPane, ID: pane.PaneID})
			continue
		}
		panes = append(panes, pane)
	}
	f.Snap.Panes = panes
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Removed: removed}, nil
}

func (f *Fake) createConversationLocked(operationID string, command CreateConversationCommand) (Receipt, error) {
	if command.AgentKind != "" && !containsAgent(f.AgentKinds, command.AgentKind) {
		return notApplied(operationID, unsupported("create_conversation", "agent kind is not available"))
	}
	if command.CWD != "" && !filepath.IsAbs(command.CWD) {
		return notApplied(operationID, invalidFault("create_conversation", "cwd must be absolute"))
	}
	if command.AgentKind != "" && command.AgentName != "" && !validAgentName.MatchString(command.AgentName) {
		return notApplied(operationID, invalidFault("create_conversation", "invalid agent name"))
	}
	workspaceID := fmt.Sprintf("w%d", f.next)
	tabID := workspaceID + ":t1"
	paneID := workspaceID + ":p1"
	f.next++
	label := command.Label
	if label == "" {
		label = command.AgentKind
	}
	if label == "" {
		label = "terminal"
	}
	f.Snap.Workspaces = append(f.Snap.Workspaces, Workspace{WorkspaceID: workspaceID, Number: len(f.Snap.Workspaces) + 1, Label: label, Cwd: command.CWD, AgentStatus: "idle"})
	f.Snap.Tabs = append(f.Snap.Tabs, Tab{TabID: tabID, WorkspaceID: workspaceID, Label: "main"})
	f.Snap.Panes = append(f.Snap.Panes, Pane{PaneID: paneID, WorkspaceID: workspaceID, TabID: tabID, Cwd: command.CWD, Agent: command.AgentKind, AgentStatus: "idle"})
	f.Panes[paneID] = &PaneState{}
	created := []EntityRef{
		{Kind: EntityWorkspace, ID: workspaceID}, {Kind: EntityTab, ID: tabID}, {Kind: EntityPane, ID: paneID},
	}
	if command.AgentKind == "" {
		return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: created}, nil
	}
	agentName := command.AgentName
	if agentName == "" {
		agentName = generatedAgentName(command.AgentKind, operationID)
	}
	created = append(created, EntityRef{Kind: EntityAgent, ID: agentName})
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: created}, nil
}

func (f *Fake) createTabLocked(operationID string, command CreateTabCommand) (Receipt, error) {
	if !f.hasWorkspaceLocked(command.WorkspaceID) {
		return notApplied(operationID, notFoundFault("tab.create", EntityWorkspace, command.WorkspaceID))
	}
	if command.CWD != "" && !filepath.IsAbs(command.CWD) {
		return notApplied(operationID, invalidFault("tab.create", "cwd must be absolute"))
	}
	tabID := fmt.Sprintf("%s:t%d", command.WorkspaceID, f.next)
	paneID := fmt.Sprintf("%s:p%d", command.WorkspaceID, f.next)
	f.next++
	label := command.Label
	if label == "" {
		label = "tab"
	}
	f.Snap.Tabs = append(f.Snap.Tabs, Tab{TabID: tabID, WorkspaceID: command.WorkspaceID, Label: label})
	f.Snap.Panes = append(f.Snap.Panes, Pane{PaneID: paneID, WorkspaceID: command.WorkspaceID, TabID: tabID, Cwd: command.CWD, AgentStatus: "idle"})
	f.Panes[paneID] = &PaneState{}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: []EntityRef{{Kind: EntityTab, ID: tabID}, {Kind: EntityPane, ID: paneID}}}, nil
}

func (f *Fake) splitPaneLocked(operationID string, command SplitPaneCommand) (Receipt, error) {
	if f.Panes[command.TargetPaneID] == nil {
		return notApplied(operationID, notFoundFault("pane.split", EntityPane, command.TargetPaneID))
	}
	if command.Direction != SplitRight && command.Direction != SplitDown {
		return notApplied(operationID, invalidFault("pane.split", "invalid split direction"))
	}
	if command.CWD != "" && !filepath.IsAbs(command.CWD) {
		return notApplied(operationID, invalidFault("pane.split", "cwd must be absolute"))
	}
	if command.Ratio != nil && (*command.Ratio <= 0 || *command.Ratio >= 1) {
		return notApplied(operationID, invalidFault("pane.split", "ratio must be between zero and one"))
	}
	var target Pane
	for _, pane := range f.Snap.Panes {
		if pane.PaneID == command.TargetPaneID {
			target = pane
			break
		}
	}
	paneID := fmt.Sprintf("%s:p%d", target.WorkspaceID, f.next)
	f.next++
	f.Snap.Panes = append(f.Snap.Panes, Pane{PaneID: paneID, WorkspaceID: target.WorkspaceID, TabID: target.TabID, Cwd: command.CWD, AgentStatus: "idle"})
	f.Panes[paneID] = &PaneState{}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: []EntityRef{{Kind: EntityPane, ID: paneID}}}, nil
}

func (f *Fake) hasWorkspaceLocked(workspaceID string) bool {
	for _, workspace := range f.Snap.Workspaces {
		if workspace.WorkspaceID == workspaceID {
			return true
		}
	}
	return false
}

func (f *Fake) openFakeWorktreeLocked(operationID string, index int) (Receipt, error) {
	worktree := &f.Worktrees[index]
	workspaceID := fmt.Sprintf("w%d", f.next)
	tabID := workspaceID + ":t1"
	paneID := workspaceID + ":p1"
	f.next++
	worktree.OpenWorkspaceID = &workspaceID
	label := worktree.Label
	if label == "" {
		label = filepath.Base(worktree.Path)
	}
	f.Snap.Workspaces = append(f.Snap.Workspaces, Workspace{WorkspaceID: workspaceID, Number: len(f.Snap.Workspaces) + 1, Label: label, Cwd: worktree.Path, AgentStatus: "idle"})
	f.Snap.Tabs = append(f.Snap.Tabs, Tab{TabID: tabID, WorkspaceID: workspaceID, Label: "main"})
	f.Snap.Panes = append(f.Snap.Panes, Pane{PaneID: paneID, WorkspaceID: workspaceID, TabID: tabID, Cwd: worktree.Path, AgentStatus: "idle"})
	f.Panes[paneID] = &PaneState{}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: []EntityRef{
		{Kind: EntityWorktree, ID: worktree.Path}, {Kind: EntityWorkspace, ID: workspaceID},
		{Kind: EntityTab, ID: tabID}, {Kind: EntityPane, ID: paneID},
	}}, nil
}

func (f *Fake) SetVisible(paneID, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if pane := f.Panes[paneID]; pane != nil {
		pane.Text = text
	}
}

func contextFault(operation string, cause error, mutating bool) error {
	if cause == nil {
		return nil
	}
	retry := RetryReadSafe
	if mutating {
		retry = RetryUserOnly
	}
	return &Fault{Code: CodeTimeout, Operation: operation, Outcome: OutcomeNotApplied, Retry: retry, SafeMessage: cause.Error(), Cause: cause}
}

func notFoundFault(operation string, kind EntityKind, id string) error {
	ref := EntityRef{Kind: kind, ID: id}
	return &Fault{Code: CodeNotFound, Operation: operation, Target: &ref, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: fmt.Sprintf("%s not found", kind)}
}

func updatedReceipt(operationID string, kind EntityKind, id string) Receipt {
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: kind, ID: id}}}
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneNonEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
