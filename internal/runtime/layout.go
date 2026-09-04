package runtime

// Tab layout geometry from Herdr session.snapshot. Rects are terminal cells.
type LayoutRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

type LayoutPane struct {
	PaneID  string     `json:"pane_id"`
	Focused bool       `json:"focused"`
	Rect    LayoutRect `json:"rect"`
}

type LayoutSplit struct {
	ID        string     `json:"id"`
	Direction string     `json:"direction"`
	Ratio     float64    `json:"ratio"`
	Rect      LayoutRect `json:"rect"`
}

type TabLayout struct {
	WorkspaceID   string        `json:"workspace_id"`
	TabID         string        `json:"tab_id"`
	Zoomed        bool          `json:"zoomed"`
	Area          LayoutRect    `json:"area"`
	FocusedPaneID string        `json:"focused_pane_id"`
	Panes         []LayoutPane  `json:"panes"`
	Splits        []LayoutSplit `json:"splits,omitempty"`
}

const (
	defaultLayoutCols = 120
	defaultLayoutRows = 40
)

type herdrLayoutRectWire struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

type herdrLayoutPaneWire struct {
	PaneID  string              `json:"pane_id"`
	Focused bool                `json:"focused"`
	Rect    herdrLayoutRectWire `json:"rect"`
}

type herdrLayoutSplitWire struct {
	ID        string              `json:"id"`
	Direction string              `json:"direction"`
	Ratio     float64             `json:"ratio"`
	Rect      herdrLayoutRectWire `json:"rect"`
}

type herdrLayoutWire struct {
	WorkspaceID   string                 `json:"workspace_id"`
	TabID         string                 `json:"tab_id"`
	Zoomed        bool                   `json:"zoomed"`
	Area          herdrLayoutRectWire    `json:"area"`
	FocusedPaneID string                 `json:"focused_pane_id"`
	Panes         []herdrLayoutPaneWire  `json:"panes"`
	Splits        []herdrLayoutSplitWire `json:"splits"`
}

func normalizeLayouts(raw []herdrLayoutWire) []TabLayout {
	if len(raw) == 0 {
		return nil
	}
	out := make([]TabLayout, 0, len(raw))
	for _, item := range raw {
		layout, ok := normalizeLayout(item)
		if !ok {
			continue
		}
		out = append(out, layout)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeLayout(raw herdrLayoutWire) (TabLayout, bool) {
	if !validResourceID.MatchString(raw.WorkspaceID) || !validResourceID.MatchString(raw.TabID) {
		return TabLayout{}, false
	}
	if raw.FocusedPaneID != "" && !validResourceID.MatchString(raw.FocusedPaneID) {
		return TabLayout{}, false
	}
	area, ok := normalizeRect(raw.Area)
	if !ok {
		return TabLayout{}, false
	}
	panes := make([]LayoutPane, 0, len(raw.Panes))
	for _, pane := range raw.Panes {
		if !validResourceID.MatchString(pane.PaneID) {
			continue
		}
		rect, rectOK := normalizeRect(pane.Rect)
		if !rectOK {
			continue
		}
		panes = append(panes, LayoutPane{PaneID: pane.PaneID, Focused: pane.Focused, Rect: rect})
	}
	if len(panes) == 0 {
		return TabLayout{}, false
	}
	splits := make([]LayoutSplit, 0, len(raw.Splits))
	for _, split := range raw.Splits {
		if split.ID == "" || utf8Len(split.ID) > 256 {
			continue
		}
		rect, rectOK := normalizeRect(split.Rect)
		if !rectOK {
			continue
		}
		ratio := split.Ratio
		if ratio <= 0 || ratio >= 1 {
			ratio = 0.5
		}
		splits = append(splits, LayoutSplit{ID: split.ID, Direction: split.Direction, Ratio: ratio, Rect: rect})
	}
	return TabLayout{
		WorkspaceID: raw.WorkspaceID, TabID: raw.TabID, Zoomed: raw.Zoomed, Area: area,
		FocusedPaneID: raw.FocusedPaneID, Panes: panes, Splits: splits,
	}, true
}

func normalizeRect(raw herdrLayoutRectWire) (LayoutRect, bool) {
	if raw.X < 0 || raw.Y < 0 || raw.Width <= 0 || raw.Height <= 0 || raw.Width > 65535 || raw.Height > 65535 {
		return LayoutRect{}, false
	}
	return LayoutRect{X: raw.X, Y: raw.Y, Width: raw.Width, Height: raw.Height}, true
}

func utf8Len(value string) int {
	return len([]rune(value))
}

func DefaultTabLayout(workspaceID, tabID, paneID string) TabLayout {
	area := LayoutRect{Width: defaultLayoutCols, Height: defaultLayoutRows}
	return TabLayout{
		WorkspaceID: workspaceID, TabID: tabID, Area: area, FocusedPaneID: paneID,
		Panes: []LayoutPane{{PaneID: paneID, Focused: true, Rect: area}},
	}
}

func SplitLayoutPane(layout TabLayout, targetID string, direction SplitDirection, ratio float64, newID string) TabLayout {
	if ratio <= 0 || ratio >= 1 {
		ratio = 0.5
	}
	for i, pane := range layout.Panes {
		if pane.PaneID != targetID {
			continue
		}
		first, second, ok := splitRect(pane.Rect, direction, ratio)
		if !ok {
			break
		}
		layout.Panes[i].Rect = first
		layout.Panes = append(layout.Panes, LayoutPane{PaneID: newID, Rect: second})
		return layout
	}
	return layout
}

func splitRect(rect LayoutRect, direction SplitDirection, ratio float64) (LayoutRect, LayoutRect, bool) {
	switch direction {
	case SplitRight:
		left := int(float64(rect.Width) * ratio)
		if left < 1 {
			left = 1
		}
		if left >= rect.Width {
			left = rect.Width - 1
		}
		if left < 1 {
			return LayoutRect{}, LayoutRect{}, false
		}
		return LayoutRect{X: rect.X, Y: rect.Y, Width: left, Height: rect.Height},
			LayoutRect{X: rect.X + left, Y: rect.Y, Width: rect.Width - left, Height: rect.Height}, true
	case SplitDown:
		top := int(float64(rect.Height) * ratio)
		if top < 1 {
			top = 1
		}
		if top >= rect.Height {
			top = rect.Height - 1
		}
		if top < 1 {
			return LayoutRect{}, LayoutRect{}, false
		}
		return LayoutRect{X: rect.X, Y: rect.Y, Width: rect.Width, Height: top},
			LayoutRect{X: rect.X, Y: rect.Y + top, Width: rect.Width, Height: rect.Height - top}, true
	default:
		return LayoutRect{}, LayoutRect{}, false
	}
}

func RemoveLayoutPane(layout TabLayout, paneID string) TabLayout {
	remaining := make([]LayoutPane, 0, len(layout.Panes))
	for _, pane := range layout.Panes {
		if pane.PaneID != paneID {
			remaining = append(remaining, pane)
		}
	}
	if len(remaining) == 0 {
		layout.Panes = nil
		layout.FocusedPaneID = ""
		return layout
	}
	if len(remaining) == 1 {
		remaining[0].Rect = layout.Area
		remaining[0].Focused = true
		layout.FocusedPaneID = remaining[0].PaneID
	} else if layout.FocusedPaneID == paneID {
		layout.FocusedPaneID = remaining[0].PaneID
	}
	layout.Panes = remaining
	return layout
}

func upsertLayout(layouts []TabLayout, next TabLayout) []TabLayout {
	out := make([]TabLayout, 0, len(layouts)+1)
	replaced := false
	for _, item := range layouts {
		if item.TabID == next.TabID {
			out = append(out, next)
			replaced = true
			continue
		}
		out = append(out, item)
	}
	if !replaced {
		out = append(out, next)
	}
	return out
}

func dropLayouts(layouts []TabLayout, drop func(TabLayout) bool) []TabLayout {
	out := make([]TabLayout, 0, len(layouts))
	for _, item := range layouts {
		if drop(item) {
			continue
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func layoutByTab(layouts []TabLayout, tabID string) (TabLayout, bool) {
	for _, item := range layouts {
		if item.TabID == tabID {
			return item, true
		}
	}
	return TabLayout{}, false
}

func cloneLayouts(layouts []TabLayout) []TabLayout {
	if len(layouts) == 0 {
		return nil
	}
	out := make([]TabLayout, len(layouts))
	for i, item := range layouts {
		out[i] = item
		if item.Panes != nil {
			out[i].Panes = append([]LayoutPane(nil), item.Panes...)
		}
		if item.Splits != nil {
			out[i].Splits = append([]LayoutSplit(nil), item.Splits...)
		}
	}
	return out
}
