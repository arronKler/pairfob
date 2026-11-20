//go:build !darwin || !cgo

package remotedesktop

func nativeAvailable() bool           { return false }
func onExternalPower() bool           { return false }
func acquireStandby() (func(), error) { return nil, ErrUnavailable }
