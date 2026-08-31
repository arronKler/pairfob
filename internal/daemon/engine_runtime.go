package daemon

// RuntimeConfig contains process-level overrides selected by the daemon
// bootstrap. Empty identity and relay fields preserve restored state.
type RuntimeConfig struct {
	MuxProtocol    int
	Origin         string
	RelayURL       string
	ReconnectToken string
	DaemonID       string
	PushEnabled    bool
	AutoAdmit      bool
}

// RuntimeTarget is the connection state the bootstrap needs after applying
// runtime configuration.
type RuntimeTarget struct {
	RelayURL string
	DaemonID string
}

// ConfigureRuntime applies startup-only overrides through one Engine boundary.
func (e *Engine) ConfigureRuntime(config RuntimeConfig) RuntimeTarget {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.MuxProtocol = config.MuxProtocol
	if config.Origin != "" {
		e.Origin = config.Origin
	}
	if config.RelayURL != "" {
		e.RelayURL = config.RelayURL
	}
	if config.ReconnectToken != "" {
		e.Reconnect = config.ReconnectToken
	}
	if config.DaemonID != "" {
		e.DaemonID = config.DaemonID
		e.Identity.DaemonID = config.DaemonID
	}
	e.PushEnabled = config.PushEnabled
	e.AutoAdmit = config.AutoAdmit

	return RuntimeTarget{RelayURL: e.RelayURL, DaemonID: e.DaemonID}
}
