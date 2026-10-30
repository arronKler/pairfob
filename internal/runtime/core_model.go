package runtime

import (
	"regexp"
	"sort"
	"strings"
)

// Core's public RPC models machines and terminals. Pairfob's snapshot
// vocabulary is workspaces, tabs and panes, so the projection below gives each
// terminal its own one-pane tab and each machine with live terminals a
// workspace. Core has no splits or layout trees, and none are invented here.

const (
	coreLocalWorkspaceID = "core"
	coreMachinePrefix    = "machine:"
	coreTabPrefix        = "term:"
	coreLocalLabel       = "This computer"
	corePaneLabelKey     = "pairfob.label"
)

type coreStatus struct {
	State string `json:"state"`
	App   string `json:"app"`
}

type coreForeground struct {
	Cwd string `json:"cwd"`
}

type coreTerminal struct {
	Address    string            `json:"address"`
	State      string            `json:"state"`
	Cwd        string            `json:"cwd"`
	Cols       uint16            `json:"cols"`
	Rows       uint16            `json:"rows"`
	Name       *string           `json:"name"`
	Title      string            `json:"title"`
	Labels     map[string]string `json:"labels"`
	Status     *coreStatus       `json:"status"`
	Foreground *coreForeground   `json:"foreground"`
}

// Terminals is a pointer so a response that omits the field is rejected
// instead of being read as an empty core.
type coreListResult struct {
	Terminals *[]coreTerminal `json:"terminals"`
}

type coreTemplatesResult struct {
	Templates []coreTemplate `json:"templates"`
}

type coreRemoveResult struct {
	Removed string `json:"removed"`
}

type coreTemplate struct {
	Name string `json:"name"`
}

type coreReadResult struct {
	Text     string `json:"text"`
	Complete bool   `json:"complete"`
	How      string `json:"how"`
}

type coreRunResult struct {
	Address string `json:"address"`
}

type coreSendResult struct {
	Turn uint64 `json:"turn"`
}

type coreKeysResult struct {
	Turn uint64 `json:"turn"`
}

type coreHello struct {
	Generation uint32
	Version    string
	CoreID     string
	CoreName   string
	Framed     bool
	Methods    map[string]bool
}

func (h coreHello) has(method string) bool { return h.Methods[method] }

var (
	coreAddressPartPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	coreAddressPattern     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}(/[A-Za-z0-9._-]{1,64})?$`)
	corePaneIDPattern      = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}(:[A-Za-z0-9._-]{1,64})?$`)
	coreTerminalName       = regexp.MustCompile(`^[a-z0-9._-]{1,32}$`)
)

// encodeCorePaneID maps a core terminal address onto a Pairfob pane id. A
// remote address has exactly one slash, so replacing it keeps the id inside
// proto/rpc.schema.json's paneId pattern.
func encodeCorePaneID(address string) (string, error) {
	if !coreAddressPattern.MatchString(address) {
		return "", invalidFault("pane", "invalid terminal address")
	}
	return strings.Replace(address, "/", ":", 1), nil
}

func decodeCorePaneID(paneID string) (string, error) {
	if !corePaneIDPattern.MatchString(paneID) {
		return "", invalidFault("pane", "invalid pane id")
	}
	return strings.Replace(paneID, ":", "/", 1), nil
}

func encodeCoreAddress(address string) string { return strings.Replace(address, "/", ":", 1) }

func coreMachineOf(address string) string {
	if index := strings.IndexByte(address, '/'); index >= 0 {
		return address[:index]
	}
	return ""
}

func coreWorkspaceKey(address string) string {
	if machine := coreMachineOf(address); machine != "" {
		return coreMachinePrefix + machine
	}
	return coreLocalWorkspaceID
}

func coreWorkspaceLabel(key string) string {
	if machine := strings.TrimPrefix(key, coreMachinePrefix); machine != key {
		return machine
	}
	return coreLocalLabel
}

func validateCoreTerminal(operation string, terminal coreTerminal) error {
	if !coreAddressPattern.MatchString(terminal.Address) {
		return coreProtocol(operation, "invalid terminal address")
	}
	if terminal.State != "live" && terminal.State != "finished" {
		return coreProtocol(operation, "invalid terminal state")
	}
	if terminal.Name != nil && *terminal.Name != "" && !coreTerminalName.MatchString(*terminal.Name) {
		return coreProtocol(operation, "invalid terminal name")
	}
	if terminal.Status != nil && terminal.Status.State == "" {
		return coreProtocol(operation, "invalid terminal status")
	}
	return nil
}

// coreAgent reads the core's own status record. A null status is not an idle
// agent, so it stays empty rather than inventing state. Core's error word has
// no place in the phone's vocabulary; it is an attention state, so it is
// reported where the phone already alerts.
func coreAgent(status *coreStatus) (agent, display, agentStatus string) {
	if status == nil {
		return "", "", ""
	}
	display = strings.TrimSpace(status.App)
	agent = strings.Join(strings.Fields(strings.ToLower(display)), "-")
	agentStatus = strings.TrimSpace(status.State)
	if agentStatus == "error" {
		agentStatus = "blocked"
	}
	return agent, display, agentStatus
}

// corePaneLabel prefers the label Pairfob itself writes, so a rename stays
// visible after a reload. Core's name is the fallback; clearing the Pairfob
// label therefore returns the pane to its core name.
func corePaneLabel(terminal coreTerminal) *string {
	if label := terminal.Labels[corePaneLabelKey]; label != "" {
		return &label
	}
	if terminal.Name != nil && *terminal.Name != "" {
		return cloneString(terminal.Name)
	}
	return nil
}

// coreResolvedCwd is where the program actually runs, which is what the
// phone's file root needs. Core's terminal.cwd is only the start directory.
func coreResolvedCwd(terminal coreTerminal) string {
	if terminal.Foreground != nil && strings.TrimSpace(terminal.Foreground.Cwd) != "" {
		return terminal.Foreground.Cwd
	}
	return terminal.Cwd
}

func coreWorkspaceAgentStatus(statuses []string) string {
	seen := make(map[string]bool, len(statuses))
	for _, status := range statuses {
		seen[status] = true
	}
	switch {
	case seen["working"]:
		return "working"
	case seen["blocked"]:
		return "blocked"
	case seen["done"]:
		return "done"
	case seen["idle"]:
		return "idle"
	}
	return ""
}

// corePaneScroll matches Pane.Scroll's anonymous type so a one-pane tab can
// report the terminal's viewport without inventing scroll state.
type corePaneScroll = struct {
	OffsetFromBottom int `json:"offset_from_bottom"`
	ViewportRows     int `json:"viewport_rows"`
}

// coreTabLayout gives the one-pane tab the terminal's real grid. Core has no
// splits or layout tree, so the area is the pane and the pane fills it.
func coreTabLayout(workspaceID, tabID, paneID string, cols, rows int) TabLayout {
	if cols <= 0 {
		cols = defaultLayoutCols
	}
	if rows <= 0 {
		rows = defaultLayoutRows
	}
	area := LayoutRect{Width: cols, Height: rows}
	return TabLayout{
		WorkspaceID: workspaceID, TabID: tabID, Area: area, FocusedPaneID: paneID,
		Panes: []LayoutPane{{PaneID: paneID, Focused: true, Rect: area}},
	}
}

func corePaneProjection(terminal coreTerminal, workspaceID string) Pane {
	paneID := encodeCoreAddress(terminal.Address)
	agent, display, agentStatus := coreAgent(terminal.Status)
	pane := Pane{
		PaneID: paneID, WorkspaceID: workspaceID, TabID: coreTabPrefix + paneID,
		Agent: agent, DisplayAgent: display, AgentStatus: agentStatus,
		Label: corePaneLabel(terminal), TerminalTitle: strings.TrimSpace(terminal.Title),
		TerminalID: terminal.Address,
	}
	cwd := coreResolvedCwd(terminal)
	if coreMachineOf(terminal.Address) == "" {
		pane.Cwd = cwd
	} else if cwd != "" {
		// A remote path must never be read as a local root. It stays a display
		// token; the daemon gates file capabilities separately.
		pane.Tokens = map[string]string{"cwd": cwd}
	}
	if terminal.Rows > 0 {
		pane.Scroll = &corePaneScroll{ViewportRows: int(terminal.Rows)}
	}
	return pane
}

func projectCoreSnapshot(hello coreHello, terminals []coreTerminal, capturedAt int64) Snapshot {
	out := Snapshot{
		HerdrVersion: hello.Version, HerdrProtocol: int(hello.Generation), CapturedAt: capturedAt,
		// Core exposes no selected pane; a synthetic focus would make the PWA
		// open a terminal the user never chose.
		Focused: map[string]string{}, Workspaces: []Workspace{}, Tabs: []Tab{}, Panes: []Pane{},
	}
	local, seen := false, map[string]bool{}
	machines := make([]string, 0, 4)
	for _, terminal := range terminals {
		if terminal.State != "live" {
			continue
		}
		key := coreWorkspaceKey(terminal.Address)
		if key == coreLocalWorkspaceID {
			local = true
			continue
		}
		if !seen[key] {
			seen[key] = true
			machines = append(machines, key)
		}
	}
	order := machines
	if local {
		order = append([]string{coreLocalWorkspaceID}, machines...)
	}
	for index, key := range order {
		workspace := Workspace{WorkspaceID: key, Number: index + 1, Label: coreWorkspaceLabel(key)}
		statuses := make([]string, 0, 4)
		for _, terminal := range terminals {
			if terminal.State != "live" || coreWorkspaceKey(terminal.Address) != key {
				continue
			}
			projected := corePaneProjection(terminal, key)
			out.Panes = append(out.Panes, projected)
			tabLabel := ""
			if projected.Label != nil {
				tabLabel = *projected.Label
			}
			out.Tabs = append(out.Tabs, Tab{TabID: projected.TabID, WorkspaceID: key, Label: tabLabel})
			out.Layouts = append(out.Layouts, coreTabLayout(key, projected.TabID, projected.PaneID, int(terminal.Cols), int(terminal.Rows)))
			statuses = append(statuses, projected.AgentStatus)
		}
		workspace.AgentStatus = coreWorkspaceAgentStatus(statuses)
		out.Workspaces = append(out.Workspaces, workspace)
	}
	return out
}

func coreLiveTerminals(terminals []coreTerminal) ([]coreTerminal, error) {
	out := make([]coreTerminal, 0, len(terminals))
	seen := make(map[string]bool, len(terminals))
	for _, terminal := range terminals {
		if err := validateCoreTerminal("terminal.list", terminal); err != nil {
			return nil, err
		}
		if seen[terminal.Address] {
			return nil, coreProtocol("terminal.list", "duplicate terminal address")
		}
		seen[terminal.Address] = true
		if terminal.State == "live" {
			out = append(out, terminal)
		}
	}
	return out, nil
}

var coreAllFeatures = []Feature{
	FeatureSnapshot, FeaturePaneRead, FeaturePaneInput, FeatureRename, FeatureClose,
	FeatureCreateConversation, FeatureCreateTab, FeatureSplitPane, FeaturePromptAgent,
	FeatureWorktreeList, FeatureWorktreeCreate, FeatureWorktreeOpen,
	FeatureLayoutResize, FeatureLayoutSwap, FeatureLayoutZoom, FeatureHistory,
	FeatureTranscript, FeatureAgentInspect,
}

// Each capability is tied to the exact hello methods it needs. A missing
// method is false; nothing is inferred from the core version.
var coreFeatureMethods = map[Feature][]string{
	FeatureSnapshot:           {"terminal.list"},
	FeaturePaneRead:           {"terminal.read"},
	FeaturePaneInput:          {"terminal.get", "terminal.keys", "terminal.send", "terminal.attach"},
	FeatureRename:             {"terminal.label"},
	FeatureClose:              {"terminal.kill"},
	FeatureCreateConversation: {"terminal.run"},
	FeaturePromptAgent:        {"terminal.send"},
}

func coreCapabilities(methods map[string]bool) map[Feature]Capability {
	out := make(map[Feature]Capability, len(coreAllFeatures))
	for _, feature := range coreAllFeatures {
		required := coreFeatureMethods[feature]
		available := len(required) > 0
		for _, method := range required {
			if !methods[method] {
				available = false
				break
			}
		}
		if available {
			out[feature] = Capability{Available: true}
			continue
		}
		reason := "unsupported by the terminal core"
		if feature == FeatureHistory || feature == FeatureTranscript {
			reason = "the terminal core has no agent transcript binding"
		}
		out[feature] = Capability{Reason: reason}
	}
	return out
}

func coreAgentKinds(result coreTemplatesResult) []AgentKind {
	seen := make(map[string]struct{}, len(result.Templates))
	values := make([]string, 0, len(result.Templates))
	for _, template := range result.Templates {
		if !validAgentName.MatchString(template.Name) {
			continue
		}
		if _, duplicate := seen[template.Name]; duplicate {
			continue
		}
		seen[template.Name] = struct{}{}
		values = append(values, template.Name)
	}
	sort.Strings(values)
	kinds := make([]AgentKind, 0, len(values))
	for _, value := range values {
		kinds = append(kinds, AgentKind{Kind: value})
	}
	return kinds
}
