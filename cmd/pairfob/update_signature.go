package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const macDaemonIdentifier = "com.pairfob.daemon"

var (
	macTeamID                 = regexp.MustCompile(`^[A-Z0-9]{10}$`)
	macCertificateRequirement = regexp.MustCompile(`certificate (?:leaf|0|root)\s*=\s*H"[0-9A-Fa-f]{40}"`)
)

type macIdentity struct {
	identifier, team, requirement string
	adhoc                         bool
}
type codesignRunner func(...string) ([]byte, error)

// Bounded metadata only; never expose codesign's raw error in a phone response.
type signatureOutput struct{ data []byte }

func (b *signatureOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.data)+n > 64*1024 {
		return 0, errors.New("signature metadata too large")
	}
	b.data = append(b.data, p...)
	return n, nil
}

func runCodesign(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/codesign", args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "LANG=C")
	cmd.WaitDelay = 200 * time.Millisecond
	out := &signatureOutput{}
	cmd.Stdout, cmd.Stderr = out, out
	err := cmd.Run()
	return out.data, err
}

func readMacIdentity(path string, run codesignRunner) (macIdentity, error) {
	raw, err := run("--display", "--verbose=4", "--requirements", "-", path)
	if err != nil {
		if strings.Contains(string(raw), "code object is not signed at all") {
			return macIdentity{}, nil
		}
		return macIdentity{}, errors.New("cannot inspect macOS code signature")
	}
	var identity macIdentity
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "Signature=adhoc" {
			identity.adhoc = true
		}
		if value, ok := strings.CutPrefix(line, "Identifier="); ok {
			identity.identifier = value
		}
		if value, ok := strings.CutPrefix(line, "TeamIdentifier="); ok && value != "not set" {
			identity.team = value
		}
		if at := strings.Index(line, "designated => "); at >= 0 {
			identity.requirement = line[at+len("designated => "):]
		}
	}
	if identity.identifier == "" {
		return macIdentity{}, errors.New("missing macOS signing identity")
	}
	if identity.team != "" && (!macTeamID.MatchString(identity.team) || identity.identifier == "" || identity.requirement == "") {
		return macIdentity{}, errors.New("invalid macOS signing identity")
	}
	return identity, nil
}

// A self-signed release pins the certificate leaf, not the binary hash. TCC
// keeps grants across updates when that requirement stays unchanged.
func macStableCertificate(identity macIdentity) bool {
	return identity.team == "" && !identity.adhoc && identity.identifier == macDaemonIdentifier &&
		!strings.Contains(identity.requirement, "cdhash") &&
		macCertificateRequirement.MatchString(identity.requirement)
}

const macDeveloperRequirement = `anchor apple generic and identifier "%s" and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "%s"`

func verifyUpdateIdentity(current, candidate, base string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return verifyMacUpdateIdentity(current, candidate, base, runCodesign)
}

// Verify the staged image before changing the installed path or restarting it.
func checkDownloadedIdentity(current string, payload []byte, base string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	candidate, err := os.CreateTemp(filepath.Dir(current), ".pairfob-signature-*")
	if err != nil {
		return err
	}
	name := candidate.Name()
	defer os.Remove(name)
	if _, err = candidate.Write(payload); err != nil {
		candidate.Close()
		return err
	}
	if err = candidate.Close(); err != nil {
		return err
	}
	return verifyUpdateIdentity(current, name, base)
}

func verifyMacUpdateIdentity(current, candidate, base string, run codesignRunner) error {
	old, err := readMacIdentity(current, run)
	if err != nil {
		return err
	}
	// An installation without a stable publisher identity may be replaced from
	// a local fixture server. A certificate-signed image never takes this
	// shortcut, even on loopback.
	legacy := old.team == "" && (old.adhoc || old.identifier == "")
	source, _ := url.Parse(base)
	if legacy && source != nil && source.Scheme == "http" && allowedDownloadBase(base) == nil {
		return nil
	}
	next, err := readMacIdentity(candidate, run)
	if err != nil {
		return err
	}
	if next.identifier != macDaemonIdentifier {
		return errors.New("update requires the com.pairfob.daemon identifier; current binary was kept")
	}
	// An installation without a certificate may keep using the HTTPS/checksum
	// channel. Signed installations never take this path or downgrade identity.
	if next.adhoc {
		if !legacy {
			return errors.New("update would downgrade the macOS privacy identity; current binary was kept")
		}
		if allowedDownloadBase(base) != nil {
			return errors.New("invalid update source")
		}
		if _, err = run("--verify", "--strict", candidate); err != nil {
			return errors.New("update failed ad-hoc signature verification; current binary was kept")
		}
		return nil
	}
	if strings.Contains(next.requirement, "cdhash") {
		return errors.New("update requires a stable signature requirement; current binary was kept")
	}
	developerID := next.team != ""
	if !developerID && !macStableCertificate(next) {
		return errors.New("update requires a Developer ID or self-signed certificate signature; current binary was kept")
	}
	if developerID {
		required := fmt.Sprintf(macDeveloperRequirement, macDaemonIdentifier, next.team)
		if _, err = run("--verify", "--strict", "--test-requirement", "="+required, candidate); err != nil {
			return errors.New("update failed Developer ID signature verification; current binary was kept")
		}
	} else if _, err = run("--verify", "--strict", "--test-requirement", "="+next.requirement, candidate); err != nil {
		// Evaluate the candidate against its own requirement so a custom
		// requirement cannot name a certificate that did not sign it.
		return errors.New("update failed certificate signature verification; current binary was kept")
	}

	// First migration from an installation without a stable identity trusts the
	// HTTPS, signed-manifest and checksum channel, as the Developer ID migration
	// does. Later updates must keep the installed requirement.
	if legacy {
		return nil
	}
	if old.team != "" {
		if !developerID || old.team != next.team {
			return errors.New("update would change the Developer ID identity; current binary was kept")
		}
	} else if developerID {
		// One-time upgrade from the self-signed identity to Developer ID.
		return nil
	}
	if old.identifier != next.identifier || strings.Contains(old.requirement, "cdhash") {
		return errors.New("update would change macOS privacy identity; current binary was kept")
	}
	if _, err = run("--verify", "--strict", current); err != nil {
		return errors.New("installed macOS signature is invalid")
	}
	// Same Team ID or certificate alone is insufficient: the candidate must
	// satisfy the installed designated requirement. For a self-signed image
	// that requirement pins the certificate leaf hash.
	if _, err = run("--verify", "--strict", "--test-requirement", "="+old.requirement, candidate); err != nil {
		return errors.New("update does not preserve the installed macOS signing requirement")
	}
	return nil
}
