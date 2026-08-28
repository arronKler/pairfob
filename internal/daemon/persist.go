package daemon

import (
	"sort"
	"time"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/state"
)

func (e *Engine) persistRegistration() error {
	if e.Store == nil {
		return nil
	}
	e.mu.Lock()
	id := e.Identity
	id.SK = canon.B64URL(e.SK)
	id.PK = canon.B64URL(e.PK)
	id.Hostname = e.hostname()
	relay := state.Relay{URL: e.RelayURL, ReconnectToken: e.Reconnect}
	if e.MuxProtocol == 2 {
		relay.Protocol = 2
	}
	e.mu.Unlock()
	if err := e.Store.SaveIdentity(id); err != nil {
		return err
	}
	return e.Store.SaveRelay(relay)
}

func (e *Engine) deviceRowsLocked() []state.Device {
	rows := make([]state.Device, 0, len(e.Devices))
	for _, d := range e.Devices {
		rows = append(rows, state.Device{
			ID: d.ID, Label: d.Label, PSK: canon.B64URL(d.PSK), UA: d.UA,
			Created: d.Created, LastSeen: d.LastSeen, RevokedAt: d.RevokedAt,
			PushSubscriptions: append([]state.PushSubscription(nil), d.PushSubscriptions...),
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows
}

func (e *Engine) saveDevicesLocked() error {
	if e.Store == nil {
		return nil
	}
	return e.Store.SaveDevices(e.deviceRowsLocked())
}

// PutDevice installs a device credential for tests and controlled embedding.
// Invalid credentials are ignored rather than creating an unusable row.
func (e *Engine) PutDevice(id string, psk []byte) {
	if id == "" || len(id) > 128 || len(psk) != 32 {
		return
	}
	e.mu.Lock()
	cp := append([]byte(nil), psk...)
	e.Devices[id] = &Device{ID: id, PSK: cp, Created: time.Now().Unix()}
	_ = e.saveDevicesLocked()
	e.mu.Unlock()
}

func (e *Engine) ListDeviceRows() []state.Device {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.deviceRowsLocked()
}

// DeviceSummary is safe to return on the local admin socket. It intentionally
// omits the device PSK, user agent, and push endpoint/key data.
type DeviceSummary struct {
	ID                string `json:"device_id"`
	Label             string `json:"label,omitempty"`
	Created           int64  `json:"created_at"`
	LastSeen          int64  `json:"last_seen,omitempty"`
	RevokedAt         *int64 `json:"revoked_at,omitempty"`
	SubscriptionCount int    `json:"subscription_count"`
}

func (e *Engine) ListDeviceSummaries() []DeviceSummary {
	e.mu.Lock()
	defer e.mu.Unlock()
	rows := make([]DeviceSummary, 0, len(e.Devices))
	for _, d := range e.Devices {
		rows = append(rows, DeviceSummary{
			ID: d.ID, Label: d.Label, Created: d.Created, LastSeen: d.LastSeen,
			RevokedAt: d.RevokedAt, SubscriptionCount: len(d.PushSubscriptions),
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows
}

func (e *Engine) HasDevice(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	d := e.Devices[id]
	return d != nil && d.RevokedAt == nil
}
