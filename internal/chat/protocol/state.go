package protocol

import "slices"

// NewState returns an empty transcript for one chat process.
func NewState(id, agent, title string) *State {
	return &State{
		ID:      id,
		Agent:   agent,
		Title:   title,
		Status:  StatusStarting,
		Entries: []Entry{},
		Plan:    []PlanItem{},
		Modes:   []Mode{},
		Options: []Option{},
		Queue:   []QueuedPrompt{},
	}
}

// Clone deep-copies the state, so a snapshot cannot share mutable payloads
// with the live transcript.
func (s *State) Clone() *State {
	if s == nil {
		return nil
	}
	clone := *s
	clone.Entries = slices.Clone(s.Entries)
	for i := range clone.Entries {
		clone.Entries[i] = cloneEntry(clone.Entries[i])
	}
	clone.Permission = clonePermission(s.Permission)
	clone.Plan = slices.Clone(s.Plan)
	clone.Modes = slices.Clone(s.Modes)
	clone.Options = cloneOptions(s.Options)
	clone.Queue = slices.Clone(s.Queue)
	if s.Usage != nil {
		usage := *s.Usage
		clone.Usage = &usage
	}
	return &clone
}

// Entry returns the entry with the given id. The result aliases the state and
// is for reading only; mutate the transcript through Apply.
func (s *State) Entry(id string) (*Entry, bool) {
	if s == nil {
		return nil, false
	}
	index := s.entryIndex(id)
	if index < 0 {
		return nil, false
	}
	return &s.Entries[index], true
}

// PermissionOption returns the pending permission option with the given id.
func (s *State) PermissionOption(id string) (*PermissionOption, bool) {
	if s == nil || s.Permission == nil {
		return nil, false
	}
	for i := range s.Permission.Options {
		if s.Permission.Options[i].ID == id {
			return &s.Permission.Options[i], true
		}
	}
	return nil, false
}

func (s *State) entryIndex(id string) int {
	for i := range s.Entries {
		if s.Entries[i].ID == id {
			return i
		}
	}
	return -1
}

func cloneEntry(entry Entry) Entry {
	if entry.Tool != nil {
		tool := *entry.Tool
		tool.Content = slices.Clone(entry.Tool.Content)
		tool.Locations = slices.Clone(entry.Tool.Locations)
		entry.Tool = &tool
	}
	return entry
}

func clonePermission(permission *Permission) *Permission {
	if permission == nil {
		return nil
	}
	clone := *permission
	clone.Options = slices.Clone(permission.Options)
	return &clone
}

func cloneOptions(options []Option) []Option {
	clone := slices.Clone(options)
	for i := range clone {
		clone[i].Choices = slices.Clone(clone[i].Choices)
	}
	return clone
}

// nonNil keeps a state list an array on the wire, never null, when an op
// replaces it with nothing.
func nonNil[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
