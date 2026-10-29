package phone

import "encoding/json"

func (c *Client) recordEvent(raw json.RawMessage) {
	c.eventsMu.Lock()
	c.Events = append(c.Events, append(json.RawMessage(nil), raw...))
	c.eventsMu.Unlock()
}

// EventSnapshot is safe while the encrypted RPC mux is receiving frames.
func (c *Client) EventSnapshot() []json.RawMessage {
	c.eventsMu.Lock()
	defer c.eventsMu.Unlock()
	out := make([]json.RawMessage, len(c.Events))
	for i, event := range c.Events {
		out[i] = append(json.RawMessage(nil), event...)
	}
	return out
}
