package main

import (
	"fmt"
	"path/filepath"
)

const (
	legacyLaunchdLabel = "com.pairfob.pairfobd"
	legacySystemdUnit  = "pairfobd.service"
	legacyServiceLog   = "pairfobd.log"
)

func legacyServiceLayout() (serviceLayout, error) {
	layout, err := currentServiceLayout()
	if err != nil {
		return serviceLayout{}, err
	}
	layout.LaunchdLabel = legacyLaunchdLabel
	layout.SystemdUnit = legacySystemdUnit
	layout.LogPath = filepath.Join(layout.StateDir, legacyServiceLog)
	switch layout.GOOS {
	case "darwin":
		layout.UnitPath = filepath.Join(layout.Home, "Library", "LaunchAgents", legacyLaunchdLabel+".plist")
	case "linux":
		layout.UnitPath = filepath.Join(layout.Home, ".config", "systemd", "user", legacySystemdUnit)
	}
	return layout, nil
}

func migrateLegacyUserService() error {
	layout, err := legacyServiceLayout()
	if err != nil {
		return err
	}
	if err := uninstallServiceLayout(layout); err != nil {
		return fmt.Errorf("remove legacy pairfobd service: %w", err)
	}
	fmt.Printf("removed legacy user service %s\nlegacy log kept at %s\n", layout.UnitPath, layout.LogPath)
	return nil
}
