package tui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"

	"pairfob/internal/chat/protocol"
)

// menuPage is one level of the mode and option selector.
type menuPage struct {
	title string
	items []menuItem
	index int
}

type menuItem struct {
	label string
	// run performs the choice. Exactly one of run and submenu is set.
	run     func(*Model) tea.Cmd
	submenu func(*Model) *menuPage
}

type menu struct {
	pages []*menuPage
}

func (m *menu) current() *menuPage { return m.pages[len(m.pages)-1] }

// openMenu lists the session modes and config options. The terminal maps
// ctrl+m to enter, so the selector lives on ctrl+o (and f2).
func (m *Model) openMenu() {
	if m.state == nil {
		return
	}
	page := &menuPage{title: "session"}
	for _, mode := range m.state.Modes {
		modeID := mode.ID
		label := "mode  " + displayName(mode.Name, mode.ID)
		if modeID == m.state.Mode {
			label += "  (current)"
		}
		page.items = append(page.items, menuItem{
			label: label,
			run: func(mm *Model) tea.Cmd {
				return setModeCmd(mm.hub, modeID)
			},
		})
	}
	for _, option := range m.state.Options {
		option := option
		label := fmt.Sprintf("%s  %s", displayName(option.Name, option.ID), option.CurrentValue)
		page.items = append(page.items, menuItem{
			label: label,
			submenu: func(*Model) *menuPage {
				return optionPage(option)
			},
		})
	}
	if len(page.items) == 0 {
		m.status = "the agent advertises no modes or options"
		return
	}
	m.menu = &menu{pages: []*menuPage{page}}
}

func optionPage(option protocol.Option) *menuPage {
	page := &menuPage{title: displayName(option.Name, option.ID)}
	for _, choice := range option.Choices {
		value := choice.Value
		label := displayName(choice.Name, choice.Value)
		if value == option.CurrentValue {
			label += "  (current)"
		}
		page.items = append(page.items, menuItem{
			label: label,
			run: func(mm *Model) tea.Cmd {
				return setOptionCmd(mm.hub, option.ID, value)
			},
		})
	}
	return page
}

func (m *Model) handleMenuKey(name string) (tea.Model, tea.Cmd) {
	page := m.menu.current()
	switch name {
	case "up":
		if len(page.items) > 0 {
			page.index = (page.index - 1 + len(page.items)) % len(page.items)
		}
	case "down":
		if len(page.items) > 0 {
			page.index = (page.index + 1) % len(page.items)
		}
	case "enter":
		if len(page.items) == 0 {
			return m, nil
		}
		item := page.items[page.index]
		if item.submenu != nil {
			m.menu.pages = append(m.menu.pages, item.submenu(m))
			return m, nil
		}
		m.menu = nil
		if item.run != nil {
			return m, item.run(m)
		}
	case "esc":
		m.menu.pages = m.menu.pages[:len(m.menu.pages)-1]
		if len(m.menu.pages) == 0 {
			m.menu = nil
		}
	case "ctrl+o", "f2":
		m.menu = nil
	}
	return m, nil
}

func displayName(name, fallback string) string {
	if name != "" {
		return name
	}
	return fallback
}
