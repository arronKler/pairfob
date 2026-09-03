package main

import (
	"errors"
	"strings"
)

func enrollNotice(code string) string {
	switch code {
	case "rate_limited":
		return "this network has set up too many computers today. Try again tomorrow."
	default:
		return "setup did not complete. Run pairfob doctor."
	}
}

func enrollRejected(code string) error {
	return errors.New(enrollNotice(code))
}

func publicOriginError(err error) error {
	if err == nil {
		return nil
	}
	return errors.New("could not reach Pairfob. Check the network, then run pairfob doctor.")
}

func rekeyNotice(code string) string {
	switch code {
	case "bad_token":
		return "this computer is no longer enrolled. Re-run the installer."
	default:
		return "could not rotate the connection. Run pairfob doctor."
	}
}

func rekeyRejected(code string) error {
	return errors.New(rekeyNotice(code))
}

func pairSlotError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if msg == "pairing cancelled" || strings.Contains(msg, "isn't running") || strings.HasPrefix(msg, "usage:") {
		return err
	}
	switch msg {
	case "pair_ref does not match the active pairing", "pairing closed before phone proof", "no active pairing", "pair_ref required":
		return errors.New("that pairing slot is gone. Run pairfob pair again.")
	default:
		return errors.New("pairing did not finish. Run pairfob pair again, or pairfob doctor.")
	}
}

func doctorOriginNote(raw string) string {
	if raw == "" {
		return ""
	}
	switch {
	case strings.Contains(raw, "JOIN_TOKEN"):
		return "do not set PAIRFOB_JOIN_TOKEN"
	case strings.Contains(raw, "JOIN_GRANT"):
		return "do not set PAIRFOB_JOIN_GRANT"
	case strings.Contains(raw, "not set up"):
		return "not set up — re-run the installer"
	case strings.Contains(raw, "protocol does not match"):
		return "origin protocol does not match this computer"
	case strings.Contains(raw, "daemon_id"),
		strings.Contains(raw, "{"),
		strings.Contains(raw, ".json"),
		strings.Contains(raw, "PAIRFOB_"):
		return "this computer's setup looks incomplete — re-run the installer"
	case strings.Contains(raw, "HTTP"),
		strings.Contains(raw, "timeout"),
		strings.Contains(raw, "connection"),
		strings.HasPrefix(raw, "Get "),
		strings.Contains(raw, "EOF"):
		return "could not reach the site — check the network"
	default:
		if strings.Contains(raw, " — ") {
			return raw
		}
		return "could not reach the site — check the network"
	}
}
