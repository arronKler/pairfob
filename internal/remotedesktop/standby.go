package remotedesktop

import (
	"context"
	"log"
	"time"
)

func standbyMessage(enabled bool) string {
	if enabled {
		return "AC standby requested. On external power Pairfob prevents idle system sleep; screen lock remains active."
	}
	return "AC standby: off."
}

func StandbySupported() bool { return nativeAvailable() }

// The daemon owns the assertion so process exit releases it. Watch the power source
// only while there is a standing desktop grant explicitly opting into standby.
func (h LocalHost) MonitorStandby(ctx context.Context, changed <-chan struct{}) {
	h.monitorStandby(ctx, changed, 5*time.Second, onExternalPower, acquireStandby)
}

func (h LocalHost) monitorStandby(ctx context.Context, changed <-chan struct{}, interval time.Duration, powered func() bool, acquire func() (func(), error)) {
	var release func()
	defer func() {
		if release != nil {
			release()
		}
	}()
	var reported bool
	for {
		raw, err := h.read()
		g := readDecision(raw)
		enabled := err == nil && (g.Mode == "control" || g.Mode == "view") && g.Standby
		wanted := enabled && powered()
		switch {
		case wanted && release == nil:
			release, err = acquire()
			if err != nil && !reported {
				log.Printf("desktop AC standby unavailable: %v", err)
			}
			reported = err != nil
		case !wanted && release != nil:
			release()
			release = nil
		}
		var timer <-chan time.Time
		if enabled {
			timer = time.After(interval)
		}
		select {
		case <-ctx.Done():
			return
		case <-changed:
		case <-timer:
		}
	}
}
