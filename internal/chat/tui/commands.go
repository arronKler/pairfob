package tui

import (
	tea "github.com/charmbracelet/bubbletea"

	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/protocol"
)

// changeMsg is one change delivered by the hub subscription.
type changeMsg struct {
	change protocol.Change
}

// subClosedMsg reports that the hub stopped the subscription.
type subClosedMsg struct{}

// commandResultMsg carries the outcome of a view command. restore puts the
// prompt text back into the composer when the send failed.
type commandResultMsg struct {
	err     error
	restore string
}

func waitChange(sub *hub.Subscription) tea.Cmd {
	return func() tea.Msg {
		change, ok := <-sub.C
		if !ok {
			return subClosedMsg{}
		}
		return changeMsg{change: change}
	}
}

func promptCmd(transcript *hub.Hub, text string) tea.Cmd {
	return func() tea.Msg {
		return commandResultMsg{err: transcript.Prompt(text, nil), restore: text}
	}
}

func cancelCmd(transcript *hub.Hub) tea.Cmd {
	return func() tea.Msg {
		return commandResultMsg{err: transcript.Cancel()}
	}
}

func answerCmd(transcript *hub.Hub, requestID, optionID string) tea.Cmd {
	return func() tea.Msg {
		return commandResultMsg{err: transcript.Answer(requestID, optionID)}
	}
}

func setModeCmd(transcript *hub.Hub, modeID string) tea.Cmd {
	return func() tea.Msg {
		return commandResultMsg{err: transcript.SetMode(modeID)}
	}
}

func setOptionCmd(transcript *hub.Hub, optionID, value string) tea.Cmd {
	return func() tea.Msg {
		return commandResultMsg{err: transcript.SetOption(optionID, value)}
	}
}
