package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

func TestNormalizeLayoutsSkipsInvalidEntries(t *testing.T) {
	layouts := normalizeLayouts([]herdrLayoutWire{
		{
			WorkspaceID: "w1", TabID: "w1:t1", FocusedPaneID: "w1:p1",
			Area:  herdrLayoutRectWire{Width: 120, Height: 40},
			Panes: []herdrLayoutPaneWire{{PaneID: "w1:p1", Focused: true, Rect: herdrLayoutRectWire{Width: 60, Height: 40}}},
		},
		{WorkspaceID: "bad id", TabID: "w1:t2", Area: herdrLayoutRectWire{Width: 10, Height: 10}},
		{
			WorkspaceID: "w1", TabID: "w1:t3", Area: herdrLayoutRectWire{Width: 0, Height: 10},
			Panes: []herdrLayoutPaneWire{{PaneID: "w1:p3", Rect: herdrLayoutRectWire{Width: 10, Height: 10}}},
		},
	})
	if len(layouts) != 1 || layouts[0].TabID != "w1:t1" || layouts[0].Panes[0].Rect.Width != 60 {
		t.Fatalf("layouts=%+v", layouts)
	}
}

func TestSplitLayoutPaneDividesTheTargetRect(t *testing.T) {
	layout := DefaultTabLayout("w1", "w1:t1", "w1:p1")
	next := SplitLayoutPane(layout, "w1:p1", SplitRight, 0.5, "w1:p2")
	if len(next.Panes) != 2 || next.Panes[0].Rect.Width != 60 || next.Panes[1].Rect.X != 60 || next.Panes[1].Rect.Width != 60 {
		t.Fatalf("right split=%+v", next.Panes)
	}
	stacked := SplitLayoutPane(DefaultTabLayout("w1", "w1:t1", "w1:p1"), "w1:p1", SplitDown, 0.25, "w1:p2")
	if stacked.Panes[0].Rect.Height != 10 || stacked.Panes[1].Rect.Y != 10 || stacked.Panes[1].Rect.Height != 30 {
		t.Fatalf("down split=%+v", stacked.Panes)
	}
}

func TestFakeSnapshotKeepsSplitGeometry(t *testing.T) {
	fake := NewFake()
	if _, err := fake.Execute(context.Background(), DefaultSession(), "op-split-layout", SplitPaneCommand{
		TargetPaneID: "w0:p1", Direction: SplitRight, CWD: "/tmp/pairfob",
	}); err != nil {
		t.Fatal(err)
	}
	view, err := fake.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := view.(SnapshotView).Snapshot
	if len(snapshot.Layouts) != 1 || len(snapshot.Layouts[0].Panes) != 2 {
		t.Fatalf("layouts=%+v", snapshot.Layouts)
	}
	left, right := snapshot.Layouts[0].Panes[0], snapshot.Layouts[0].Panes[1]
	if left.Rect.Width+right.Rect.Width != snapshot.Layouts[0].Area.Width || right.Rect.X != left.Rect.Width {
		t.Fatalf("rects=%+v area=%+v", snapshot.Layouts[0].Panes, snapshot.Layouts[0].Area)
	}
	raw, _ := json.Marshal(snapshot)
	if !json.Valid(raw) || string(raw) == "" {
		t.Fatalf("snapshot json %s", raw)
	}
}

func TestHerdrSnapshotForwardsTabLayouts(t *testing.T) {
	socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		if request.Method != "session.snapshot" {
			return standardReply(request)
		}
		reply := standardReply(request)
		snapshot := reply.Result.(map[string]any)["snapshot"].(map[string]any)
		snapshot["layouts"] = []any{map[string]any{
			"workspace_id": "w1", "tab_id": "w1:t1", "zoomed": false, "focused_pane_id": "w1:p1",
			"area": map[string]any{"x": 0, "y": 0, "width": 100, "height": 30},
			"panes": []any{map[string]any{
				"pane_id": "w1:p1", "focused": true,
				"rect": map[string]any{"x": 0, "y": 0, "width": 100, "height": 30},
			}},
			"splits": []any{},
		}}
		return reply
	})
	herdr := NewHerdr(socket)
	view, err := herdr.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatal(err)
	}
	layouts := view.(SnapshotView).Snapshot.Layouts
	if len(layouts) != 1 || layouts[0].Area.Width != 100 || layouts[0].Panes[0].PaneID != "w1:p1" {
		t.Fatalf("layouts=%+v", layouts)
	}
}
