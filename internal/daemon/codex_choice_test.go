package daemon

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"pairfob/internal/runtime"
)

// Screen saved in herdrdev/herdr#5490. Codex 0.162.1 draws this picker after
// Plan mode; Herdr 0.9.5 reports idle because no detection rule matches.
const codexPlanPickerScreen = "" +
	"  Implement this plan?\n" +
	"\n" +
	"› 1. Yes, implement this plan          Switch to Default and start coding\n" +
	"  2. Yes, clear context and implement  Fresh thread with this plan\n" +
	"  3. No, stay in Plan mode             Continue planning with the model\n" +
	"\n" +
	"  enter select · esc back\n"

const codexComposerScreen = "› \n\n  gpt-5.4 medium\n"

type paneRead struct {
	id     string
	source string
	lines  int
}

type screenRuntime struct {
	*monitorTestRuntime
	mu    sync.Mutex
	text  map[string]string
	fail  map[string]error
	reads []paneRead
}

func (r *screenRuntime) Observe(ctx context.Context, session runtime.SessionRef, query runtime.Query) (runtime.View, error) {
	if read, ok := query.(runtime.PaneReadQuery); ok {
		r.mu.Lock()
		r.reads = append(r.reads, paneRead{id: read.PaneID, source: read.Source, lines: read.Lines})
		text, fail := r.text[read.PaneID], r.fail[read.PaneID]
		r.mu.Unlock()
		if fail != nil {
			return nil, fail
		}
		return runtime.PaneReadView{Text: text}, nil
	}
	return r.monitorTestRuntime.Observe(ctx, session, query)
}

func (r *screenRuntime) readIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, len(r.reads))
	for i, read := range r.reads {
		ids[i] = read.id
	}
	return ids
}

func TestCodexPlanPickerScreenIsAChoice(t *testing.T) {
	if !codexChoiceDialog(codexPlanPickerScreen) {
		t.Fatal("plan picker was not recognized")
	}
	if codexChoiceDialog(codexComposerScreen) {
		t.Fatal("composer was treated as a choice")
	}
	prose := "Here is the plan:\n  1. Refactor\n  2. Add tests\n  3. Ship it\n"
	if codexChoiceDialog(prose) {
		t.Fatal("a numbered list in the reply was treated as a choice")
	}
}

func TestCodexChoicePromotion(t *testing.T) {
	rt := &screenRuntime{
		monitorTestRuntime: newMonitorTestRuntime(),
		text: map[string]string{
			"plan": codexPlanPickerScreen, "quiet": codexComposerScreen,
			"done": codexPlanPickerScreen, "held": codexPlanPickerScreen, "other": codexPlanPickerScreen,
		},
	}
	engine := NewEngine(nil, nil, rt)
	rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{
		{PaneID: "plan", Agent: "codex", AgentStatus: "idle"},
		{PaneID: "quiet", Agent: "codex", AgentStatus: "idle"},
		{PaneID: "done", Agent: "codex", AgentStatus: "done"},
		{PaneID: "held", Agent: "codex", AgentStatus: "blocked"},
		{PaneID: "other", Agent: "claude", AgentStatus: "idle"},
		{PaneID: "busy", Agent: "codex", AgentStatus: "working"},
	}})
	snapshot, err := engine.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, pane := range snapshot.Panes {
		got[pane.PaneID] = pane.AgentStatus
	}
	if got["plan"] != "blocked" || got["done"] != "blocked" {
		t.Fatalf("choice was not lifted: %+v", got)
	}
	if got["quiet"] != "idle" || got["held"] != "blocked" || got["other"] != "idle" || got["busy"] != "working" {
		t.Fatalf("unrelated panes changed: %+v", got)
	}
	reads := rt.readIDs()
	if strings.Join(reads, ",") != "plan,quiet,done" {
		t.Fatalf("reads=%v want plan, quiet, done", reads)
	}
	for _, read := range rt.reads {
		if read.source != runtime.SourceRecent || read.lines != codexDialogLines {
			t.Fatalf("read=%+v", read)
		}
	}
}

func TestCodexChoiceReadFailureKeepsReportedStatus(t *testing.T) {
	rt := &screenRuntime{
		monitorTestRuntime: newMonitorTestRuntime(),
		fail:               map[string]error{"plan": errors.New("pane read failed")},
	}
	engine := NewEngine(nil, nil, rt)
	rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{
		{PaneID: "plan", Agent: "codex", AgentStatus: "idle"},
	}})
	snapshot, err := engine.snapshot(nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Panes[0].AgentStatus != "idle" {
		t.Fatalf("status=%s", snapshot.Panes[0].AgentStatus)
	}
	if strings.Join(rt.readIDs(), ",") != "plan" {
		t.Fatalf("reads=%v", rt.readIDs())
	}
}

func TestCodexChoiceNotifiesNeedsYouOnce(t *testing.T) {
	rt := &screenRuntime{
		monitorTestRuntime: newMonitorTestRuntime(),
		text:               map[string]string{"plan": codexPlanPickerScreen},
	}
	engine := NewEngine(nil, nil, rt)
	engine.PushEnabled = true
	state := sessionMonitorState{panes: map[string]monitoredPane{}}
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	observe := func(status string) {
		t.Helper()
		rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{{
			PaneID: "plan", Agent: "codex", AgentStatus: status, AgentInstanceID: "one",
		}}})
		engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &state, func(string, string) {}, emit)
	}
	observe("working")
	if len(pushes) != 0 || state.panes["plan"].status != "working" {
		t.Fatalf("startup pushes=%+v status=%s", pushes, state.panes["plan"].status)
	}
	observe("idle")
	if len(pushes) != 1 || pushes[0].Kind != PushNeedsYou || state.panes["plan"].status != "blocked" {
		t.Fatalf("idle choice pushes=%+v status=%s", pushes, state.panes["plan"].status)
	}
	observe("idle")
	if len(pushes) != 1 || state.panes["plan"].status != "blocked" {
		t.Fatalf("repeated choice pushed again: %+v", pushes)
	}
	observe("done")
	if len(pushes) != 1 || state.panes["plan"].status != "blocked" {
		t.Fatalf("done choice changed the notification: %+v status=%s", pushes, state.panes["plan"].status)
	}
}

func TestCodexDoneChoiceNotifiesNeedsYouNotCompletion(t *testing.T) {
	rt := &screenRuntime{
		monitorTestRuntime: newMonitorTestRuntime(),
		text:               map[string]string{"plan": codexPlanPickerScreen},
	}
	engine := NewEngine(nil, nil, rt)
	engine.PushEnabled = true
	state := sessionMonitorState{panes: map[string]monitoredPane{}}
	var pushes []HerdPush
	observe := func(status string) {
		t.Helper()
		rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{{
			PaneID: "plan", Agent: "codex", AgentStatus: status, AgentInstanceID: "one",
		}}})
		engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &state, func(string, string) {}, func(push HerdPush) {
			pushes = append(pushes, push)
		})
	}
	observe("working")
	observe("done")
	if len(pushes) != 1 || pushes[0].Kind != PushNeedsYou || state.panes["plan"].status != "blocked" {
		t.Fatalf("pushes=%+v status=%s", pushes, state.panes["plan"].status)
	}
	idleKind, idleNotify := pushKindForTransition("idle", true, "blocked")
	doneKind, doneNotify := pushKindForTransition("done", true, "blocked")
	if idleKind != PushNeedsYou || !idleNotify || doneKind != PushNeedsYou || !doneNotify {
		t.Fatalf("idle=%s/%v done=%s/%v", idleKind, idleNotify, doneKind, doneNotify)
	}
}
