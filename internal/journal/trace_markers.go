package journal

// Marker events extend the four original trace kinds. Clients opt in with
// TraceOptions.Markers (GetConfig.capabilities.trace_markers); older clients
// reject unknown kinds, so the default view keeps the original vocabulary.
const (
	// EventCommand is a slash or shell command in its typed form, e.g. "/clear".
	EventCommand = "command"
	// EventCompaction marks where the agent compacted its context.
	EventCompaction = "compaction"
	// EventInterrupt marks a turn the user cancelled.
	EventInterrupt = "interrupt"
)

type TraceOptions struct {
	Markers bool
	// Labels adds a one-line label to summary tool items (trace_labels).
	Labels bool
	// Times adds each summary item's record time, epoch ms (trace_times).
	Times bool
}

// adapt maps a parsed event to the client's vocabulary. Without markers a
// command reads as a user prompt and the textless markers are dropped. Source
// ordinals are assigned before adapt, so detail refs match in both views.
// Labels are derived here, from the tool's input before any clipping; record
// times survive only with Times.
func (o TraceOptions) adapt(ev parsedEvent) (parsedEvent, bool) {
	if o.Labels && ev.Type == "tool" && !ev.outputOnly {
		ev.Label = toolLabel(ev.Name, ev.Input)
	}
	if !o.Times {
		ev.At = 0
	}
	if o.Markers {
		return ev, true
	}
	switch ev.Type {
	case EventCommand:
		ev.Type = "user"
	case EventCompaction, EventInterrupt:
		return ev, false
	}
	return ev, true
}

// turnHead reports whether an event opens a turn: something the user sent.
func turnHead(kind string) bool {
	return kind == "user" || kind == EventCommand
}
