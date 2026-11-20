package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"pairfob/internal/admin"
	"pairfob/internal/remotedesktop"
	"pairfob/internal/state"
)

const desktopUsage = "usage: pairfob desktop setup|enable|enable-control|standby-on|standby-off|disable|status"

func desktopCommand(sock string, args []string) error {
	installOffer := len(args) == 2 && args[0] == "setup" && args[1] == "--if-unconfigured"
	if len(args) != 1 && !installOffer {
		return errors.New(desktopUsage)
	}
	switch args[0] {
	case "setup", "enable", "enable-control", "standby-on", "standby-off", "disable", "status":
	default:
		return errors.New(desktopUsage)
	}
	op := "desktop." + args[0]
	if installOffer {
		op = "desktop.offer"
	}
	response, err := admin.Call(sock, admin.Request{Op: op})
	if errors.Is(err, admin.ErrNotRunning) {
		dir, dirErr := state.DefaultDir()
		if dirErr != nil {
			return dirErr
		}
		canonical, pathErr := admin.DefaultSocketPathIn(dir)
		if pathErr != nil {
			return pathErr
		}
		if sock != canonical {
			return errors.New("cannot identify the offline daemon for this custom admin socket; start that daemon to inspect or revoke its desktop access")
		}
		h := remotedesktop.LocalHost{Dir: dir}
		switch args[0] {
		case "disable":
			return h.Disable()
		case "status":
			p := h.Policy()
			fmt.Printf("Saved desktop viewing: %t\nSaved desktop control: %t\nDaemon offline; system permissions not checked.\n", p.View, p.Control)
			return nil
		}
	}
	if err != nil {
		return err
	}
	var message string
	if err = json.Unmarshal(response.Result, &message); err != nil {
		return err
	}
	fmt.Println(message)
	return nil
}

func (a liveAdmin) ConfigureDesktop(mode string) (string, error) {
	h := remotedesktop.LocalHost{Dir: a.store.Dir}
	if mode != "status" {
		defer func() {
			select {
			case a.desktopChanged <- struct{}{}:
			default:
			}
		}()
	}
	if mode == "disable" {
		return "Unattended desktop: off", h.Disable()
	}
	return h.Configure(mode, a.eng.Direct != nil)
}
