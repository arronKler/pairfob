// Package tui renders one chat hub in a terminal. It is a view of the hub:
// the transcript comes from the hub's snapshot and change stream, and every
// edit goes back as a hub command.
package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/protocol"
)

// Model is the bubbletea view.
type Model struct {
	hub   *hub.Hub
	state *protocol.State
	sub   *hub.Subscription

	width  int
	height int
	offset int

	composer  composer
	menu      *menu
	permIndex int

	cancelArmed bool
	quitArmed   bool
	status      string
	errText     string
}

// New builds the model for one hub. Init subscribes to it.
func New(transcript *hub.Hub) *Model {
	return &Model{hub: transcript}
}

// Init takes the first snapshot and starts following changes.
func (m *Model) Init() tea.Cmd {
	attachment, sub := m.hub.Attach(nil, 256)
	m.state = attachment.State
	m.sub = sub
	return waitChange(sub)
}

// Update applies messages and view input.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.scroll(3)
		case tea.MouseButtonWheelDown:
			m.scroll(-3)
		}
	case changeMsg:
		if m.state != nil {
			if err := m.state.Apply(msg.change.Ops); err != nil {
				m.errText = "apply change: " + err.Error()
			}
		}
		return m, waitChange(m.sub)
	case subClosedMsg:
		m.status = "the chat process closed this view"
	case commandResultMsg:
		if msg.err != nil {
			m.errText = msg.err.Error()
			if msg.restore != "" && m.composer.Empty() {
				m.composer.SetText(msg.restore)
			}
		} else {
			m.errText = ""
		}
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

// View renders the header, the transcript window and the input area.
func (m *Model) View() string {
	if m.state == nil {
		return "connecting…"
	}
	tail := m.renderTail()
	transcriptHeight := m.transcriptHeight(len(tail))
	transcript := renderTranscript(m.state)
	body := windowLines(transcript, transcriptHeight, m.clampOffset(len(transcript), transcriptHeight))

	out := make([]string, 0, 1+len(body)+len(tail))
	out = append(out, m.renderHeader())
	out = append(out, body...)
	out = append(out, tail...)
	return strings.Join(out, "\n")
}

func (m *Model) handleKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	name := key.String()
	if name == "ctrl+c" {
		if m.quitArmed {
			return m, tea.Quit
		}
		m.quitArmed = true
		m.status = "press ctrl+c again to quit"
		return m, nil
	}
	m.quitArmed = false

	if m.menu != nil {
		return m.handleMenuKey(name)
	}
	if name == "ctrl+o" || name == "f2" {
		m.openMenu()
		return m, nil
	}
	if name == "esc" {
		return m.handleEscape()
	}
	m.cancelArmed = false

	switch name {
	case "pgup":
		m.scroll(m.page())
		return m, nil
	case "pgdown":
		m.scroll(-m.page())
		return m, nil
	}

	if m.state != nil && m.state.Permission != nil {
		switch name {
		case "up":
			if m.permIndex > 0 {
				m.permIndex--
			}
			return m, nil
		case "down":
			if m.permIndex < len(m.state.Permission.Options)-1 {
				m.permIndex++
			}
			return m, nil
		case "enter":
			return m.answerPermission()
		}
	}

	switch name {
	case "enter":
		return m.sendPrompt()
	case "ctrl+j", "alt+enter", "shift+enter":
		m.composer.Newline()
	case "backspace":
		m.composer.Backspace()
	case "delete":
		m.composer.Delete()
	case "left":
		m.composer.Left()
	case "right":
		m.composer.Right()
	case "home":
		m.composer.Home()
	case "end":
		m.composer.End()
	case "up":
		m.scroll(1)
	case "down":
		m.scroll(-1)
	default:
		if len(key.Runes) > 0 {
			m.composer.Insert(string(key.Runes))
		}
	}
	return m, nil
}

func (m *Model) handleEscape() (tea.Model, tea.Cmd) {
	if m.cancelArmed {
		m.cancelArmed = false
		m.status = ""
		return m, cancelCmd(m.hub)
	}
	if m.turnActive() {
		m.cancelArmed = true
		m.status = "press esc again to cancel the turn"
		return m, nil
	}
	return m, nil
}

func (m *Model) sendPrompt() (tea.Model, tea.Cmd) {
	text := strings.TrimSpace(m.composer.Text())
	if text == "" {
		return m, nil
	}
	m.composer.Clear()
	m.errText = ""
	m.offset = 0
	return m, promptCmd(m.hub, text)
}

func (m *Model) answerPermission() (tea.Model, tea.Cmd) {
	permission := m.state.Permission
	if len(permission.Options) == 0 {
		m.errText = "the permission request has no options"
		return m, nil
	}
	index := m.permIndex
	if index >= len(permission.Options) {
		index = len(permission.Options) - 1
	}
	return m, answerCmd(m.hub, permission.ID, permission.Options[index].ID)
}

func (m *Model) turnActive() bool {
	if m.state == nil {
		return false
	}
	return m.state.Status == protocol.StatusWorking || m.state.Status == protocol.StatusBlocked
}

func (m *Model) scroll(delta int) {
	if m.state == nil {
		return
	}
	total := len(renderTranscript(m.state))
	maximum := total - m.transcriptHeight(len(m.renderTail()))
	if maximum < 0 {
		maximum = 0
	}
	m.offset += delta
	if m.offset < 0 {
		m.offset = 0
	}
	if m.offset > maximum {
		m.offset = maximum
	}
}

func (m *Model) page() int {
	height := m.transcriptHeight(len(m.renderTail()))
	if height > 1 {
		return height - 1
	}
	return 1
}

func (m *Model) transcriptHeight(tail int) int {
	height := m.height
	if height <= 0 {
		height = 24
	}
	available := height - 1 - tail
	if available < 1 {
		available = 1
	}
	return available
}

func (m *Model) clampOffset(total, height int) int {
	maximum := total - height
	if maximum < 0 {
		maximum = 0
	}
	if m.offset < 0 {
		m.offset = 0
	}
	if m.offset > maximum {
		m.offset = maximum
	}
	return m.offset
}
