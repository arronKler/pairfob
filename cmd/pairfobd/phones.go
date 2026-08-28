package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"pairfob/internal/admin"
)

func phonesCommand(args []string, sock string) error {
	if len(args) == 0 {
		return printPhones(sock)
	}
	if len(args) >= 1 && (args[0] == "forget" || args[0] == "revoke") {
		if len(args) != 2 {
			return errors.New("usage: pairfobd forget N")
		}
		return forgetPhone(sock, args[1])
	}
	return errors.New("usage: pairfobd list\n       pairfobd forget N")
}

func deviceCommand(args []string, sock string) error {
	if len(args) == 0 || (len(args) == 1 && args[0] == "list") {
		return printPhones(sock)
	}
	if len(args) == 2 && (args[0] == "revoke" || args[0] == "forget") {
		return forgetPhone(sock, args[1])
	}
	return errors.New("usage: pairfobd list\n       pairfobd forget N")
}

func loadPhones(sock string) ([]admin.Device, error) {
	resp, err := admin.Call(sock, admin.Request{Op: "device.list"})
	if err != nil {
		return nil, notRunning(err)
	}
	if len(resp.Result) == 0 {
		return []admin.Device{}, nil
	}
	var wrapped struct {
		Devices []admin.Device `json:"devices"`
	}
	if err := json.Unmarshal(resp.Result, &wrapped); err != nil {
		return nil, errors.New("pairfobd returned an invalid device list")
	}
	rows := wrapped.Devices
	active := make([]admin.Device, 0, len(rows))
	for _, d := range rows {
		if d.RevokedAt != nil {
			continue
		}
		active = append(active, d)
	}
	return active, nil
}

func printPhones(sock string) error {
	rows, err := loadPhones(sock)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		fmt.Println("Nothing paired yet. Pair one: pairfobd pair")
		return nil
	}
	for i, d := range rows {
		label := strings.TrimSpace(d.Label)
		if label == "" {
			label = "Device"
		}
		fmt.Printf("%d  %s  %s\n", i+1, label, lastSeenPhrase(d.LastSeen))
	}
	fmt.Println("\nUnpair one: pairfobd forget 1")
	return nil
}

func forgetPhone(sock string, raw string) error {
	rows, err := loadPhones(sock)
	if err != nil {
		return err
	}
	id, err := resolvePhone(rows, raw)
	if err != nil {
		return err
	}
	if _, err := admin.Call(sock, admin.Request{Op: "device.revoke", DeviceID: id}); err != nil {
		return notRunning(err)
	}
	fmt.Println("Forgotten.")
	return nil
}

func resolvePhone(rows []admin.Device, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("which device? pairfobd list")
	}
	if n, err := strconv.Atoi(raw); err == nil {
		if n < 1 || n > len(rows) {
			return "", fmt.Errorf("no device %d — pairfobd list", n)
		}
		return rows[n-1].ID, nil
	}
	var matches []admin.Device
	lower := strings.ToLower(raw)
	for _, d := range rows {
		if d.ID == raw {
			return d.ID, nil
		}
		if strings.ToLower(strings.TrimSpace(d.Label)) == lower {
			matches = append(matches, d)
		}
	}
	if len(matches) == 1 {
		return matches[0].ID, nil
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("several devices are named %q — forget by number", raw)
	}
	return "", fmt.Errorf("no device matching %q — pairfobd list", raw)
}

func lastSeenPhrase(unix int64) string {
	if unix <= 0 {
		return "never seen"
	}
	delta := time.Since(time.Unix(unix, 0))
	if delta < 0 {
		delta = 0
	}
	switch {
	case delta < 2*time.Minute:
		return "just now"
	case delta < time.Hour:
		return fmt.Sprintf("%d min ago", int(delta.Minutes()))
	case delta < 36*time.Hour:
		h := int(delta.Hours())
		if h == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", h)
	default:
		d := int(delta.Hours() / 24)
		if d == 1 {
			return "yesterday"
		}
		return fmt.Sprintf("%d days ago", d)
	}
}
