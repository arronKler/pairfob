package daemon

import "testing"

func TestConfigureRuntimeAppliesBootstrapOverrides(t *testing.T) {
	eng := NewEngine(nil, nil, nil)
	eng.RelayURL = "wss://stored.example/v2/ws"
	eng.Reconnect = "stored-token"
	eng.DaemonID = "stored-daemon"

	target := eng.ConfigureRuntime(RuntimeConfig{
		MuxProtocol:    2,
		Origin:         "https://relay.example",
		RelayURL:       "wss://relay.example/v2/ws",
		ReconnectToken: "fresh-token",
		DaemonID:       "fresh-daemon",
		PushEnabled:    true,
		AutoAdmit:      true,
	})

	if eng.MuxProtocol != 2 || eng.Origin != "https://relay.example" {
		t.Fatalf("protocol=%d origin=%q", eng.MuxProtocol, eng.Origin)
	}
	if eng.Reconnect != "fresh-token" || eng.Identity.DaemonID != "fresh-daemon" {
		t.Fatalf("reconnect=%q identity=%q", eng.Reconnect, eng.Identity.DaemonID)
	}
	if !eng.PushEnabled || !eng.AutoAdmit {
		t.Fatalf("push=%v auto_admit=%v", eng.PushEnabled, eng.AutoAdmit)
	}
	if target.RelayURL != "wss://relay.example/v2/ws" || target.DaemonID != "fresh-daemon" {
		t.Fatalf("target=%+v", target)
	}
}

func TestConfigureRuntimePreservesRestoredConnectionFields(t *testing.T) {
	eng := NewEngine(nil, nil, nil)
	eng.Origin = "https://stored.example"
	eng.RelayURL = "wss://stored.example/v2/ws"
	eng.Reconnect = "stored-token"
	eng.DaemonID = "stored-daemon"

	target := eng.ConfigureRuntime(RuntimeConfig{MuxProtocol: 2})

	if eng.Origin != "https://stored.example" || eng.Reconnect != "stored-token" {
		t.Fatalf("origin=%q reconnect=%q", eng.Origin, eng.Reconnect)
	}
	if target.RelayURL != "wss://stored.example/v2/ws" || target.DaemonID != "stored-daemon" {
		t.Fatalf("target=%+v", target)
	}
}
