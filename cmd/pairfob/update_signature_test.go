package main

import (
	"errors"
	"strings"
	"testing"
)

const unsignedImage = "UNSIGNED"

func signatureFixture(team, id, requirement string) string {
	signature := ""
	if team == "not set" {
		signature = "Signature=adhoc\n"
	}
	return signature + "Identifier=" + id + "\nTeamIdentifier=" + team + "\ndesignated => " + requirement + "\n"
}

func certificateFixture(id, requirement string) string {
	return "Identifier=" + id + "\nTeamIdentifier=not set\ndesignated => " + requirement + "\n"
}

func fixtureRequirement(raw string) string {
	for _, line := range strings.Split(raw, "\n") {
		if value, ok := strings.CutPrefix(line, "designated => "); ok {
			return value
		}
	}
	return ""
}

func TestMacUpdateIdentityContinuity(t *testing.T) {
	stable := signatureFixture("ABCDE12345", macDaemonIdentifier, `identifier "com.pairfob.daemon" and anchor apple generic`)
	otherTeam := signatureFixture("ZZZZZ12345", macDaemonIdentifier, `identifier "com.pairfob.daemon" and certificate leaf[subject.OU] = "ZZZZZ12345"`)
	releaseAdhoc := signatureFixture("not set", macDaemonIdentifier, `cdhash H"456"`)
	adhoc := signatureFixture("not set", "a.out", `cdhash H"123"`)
	selfSignedRequirement := `identifier "com.pairfob.daemon" and certificate leaf = H"71410343dfd9a3ebe420feec337b3aa94afe6729"`
	selfSigned := certificateFixture(macDaemonIdentifier, selfSignedRequirement)
	otherCertificate := certificateFixture(macDaemonIdentifier, `identifier "com.pairfob.daemon" and certificate leaf = H"0000000000000000000000000000000000000000"`)
	hashPinnedCertificate := certificateFixture(macDaemonIdentifier, `cdhash H"789"`)
	unanchoredCertificate := certificateFixture(macDaemonIdentifier, `identifier "com.pairfob.daemon" and anchor apple generic`)
	for _, tc := range []struct {
		name, old, next, base, fail string
		want, checkOld              bool
	}{
		{"same identity", stable, stable, "https://dl.pairfob.com/daemon", "", true, true},
		{"migration", adhoc, stable, "https://dl.pairfob.com/daemon", "", true, false},
		{"unsigned migration to self-signed", unsignedImage, selfSigned, "https://dl.pairfob.com/daemon", "", true, false},
		{"wrong unsigned identifier", adhoc, adhoc, "https://dl.pairfob.com/daemon", "", false, false},
		{"public no certificate", adhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "", true, false},
		{"unsigned to ad-hoc", unsignedImage, releaseAdhoc, "https://dl.pairfob.com/daemon", "", true, false},
		{"hash pinned ad-hoc", adhoc, certificateFixture(macDaemonIdentifier, `cdhash H"456"`), "https://dl.pairfob.com/daemon", "", false, false},
		{"next no certificate", releaseAdhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "", true, false},
		{"tampered no certificate", adhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "candidate", false, false},
		{"signed refuses no certificate", stable, releaseAdhoc, "https://dl.pairfob.com/daemon", "", false, false},
		{"remote insecure", adhoc, releaseAdhoc, "http://example.com/daemon", "", false, false},
		{"signed to adhoc", stable, adhoc, "http://127.0.0.1:1234", "", false, false},
		{"other team", stable, otherTeam, "https://dl.pairfob.com/daemon", "", false, false},
		{"other identifier", stable, signatureFixture("ABCDE12345", "another.app", "anchor apple"), "https://dl.pairfob.com/daemon", "", false, false},
		{"Developer ID hash pinned", stable, signatureFixture("ABCDE12345", macDaemonIdentifier, `cdhash H"123"`), "https://dl.pairfob.com/daemon", "", false, false},
		{"tampered candidate", stable, stable, "https://dl.pairfob.com/daemon", "candidate", false, false},
		{"tampered installed", stable, stable, "https://dl.pairfob.com/daemon", "current", false, false},
		{"DR changed", stable, stable, "https://dl.pairfob.com/daemon", "requirement", false, false},
		{"local dev", adhoc, adhoc, "http://localhost:1234", "", true, false},
		{"legacy to self-signed", adhoc, selfSigned, "https://dl.pairfob.com/daemon", "", true, false},
		{"same self-signed certificate", selfSigned, selfSigned, "https://dl.pairfob.com/daemon", "", true, true},
		{"self-signed other certificate", selfSigned, otherCertificate, "https://dl.pairfob.com/daemon", "", false, false},
		{"self-signed to ad-hoc", selfSigned, releaseAdhoc, "https://dl.pairfob.com/daemon", "", false, false},
		{"self-signed to Developer ID", selfSigned, stable, "https://dl.pairfob.com/daemon", "", true, false},
		{"Developer ID to self-signed", stable, selfSigned, "https://dl.pairfob.com/daemon", "", false, false},
		{"self-signed candidate hash pinned", adhoc, hashPinnedCertificate, "https://dl.pairfob.com/daemon", "", false, false},
		{"self-signed candidate without certificate", adhoc, unanchoredCertificate, "https://dl.pairfob.com/daemon", "", false, false},
		{"local self-signed keeps requirement", selfSigned, selfSigned, "http://localhost:1234", "", true, true},
		{"local self-signed rejects ad-hoc", selfSigned, adhoc, "http://localhost:1234", "", false, false},
		{"self-signed candidate tampered", adhoc, selfSigned, "https://dl.pairfob.com/daemon", "candidate", false, false},
		{"self-signed DR changed", selfSigned, selfSigned, "https://dl.pairfob.com/daemon", "requirement", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oldRequirementChecked := false
			run := func(args ...string) ([]byte, error) {
				path := args[len(args)-1]
				if args[0] == "--display" {
					if path == "current" {
						if tc.old == unsignedImage {
							return []byte("code object is not signed at all"), errors.New("unsigned")
						}
						return []byte(tc.old), nil
					}
					return []byte(tc.next), nil
				}
				if args[0] == "--verify" {
					if tc.fail == path {
						return nil, errors.New("private signing error")
					}
					if args[2] == "--test-requirement" {
						requirement := strings.TrimPrefix(args[3], "=")
						if args[3] == "="+fixtureRequirement(tc.old) {
							oldRequirementChecked = true
							if tc.fail == "requirement" {
								return nil, errors.New("mismatch")
							}
						}
						// Simulate codesign evaluating a certificate requirement
						// against a candidate signed by a different certificate.
						if strings.Contains(requirement, `certificate leaf = H"`) &&
							!strings.Contains(tc.next, requirement) {
							return nil, errors.New("requirement mismatch")
						}
					}
				}
				return nil, nil
			}
			err := verifyMacUpdateIdentity("current", "candidate", tc.base, run)
			if (err == nil) != tc.want {
				t.Fatalf("%v", err)
			}
			if tc.checkOld && !oldRequirementChecked {
				t.Fatal("did not compare the installed designated requirement")
			}
			if err != nil && strings.Contains(err.Error(), "private signing error") {
				t.Fatal("raw command error leaked")
			}
		})
	}
}

func TestMacIdentityInspectionFailsClosed(t *testing.T) {
	for _, raw := range []string{"could not communicate with security server", "invalid signature", "permission denied"} {
		if _, err := readMacIdentity("current", func(...string) ([]byte, error) { return []byte(raw), errors.New("failed") }); err == nil {
			t.Fatal("inspection failure became unsigned migration")
		}
	}
	if _, err := readMacIdentity("current", func(...string) ([]byte, error) {
		return []byte("code object is not signed at all"), errors.New("unsigned")
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMacIdentityReadsSelfSignedCertificate(t *testing.T) {
	identity, err := readMacIdentity("current", func(...string) ([]byte, error) {
		return []byte(certificateFixture(macDaemonIdentifier, `identifier "com.pairfob.daemon" and certificate leaf = H"71410343dfd9a3ebe420feec337b3aa94afe6729"`)), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if identity.team != "" || identity.adhoc || !macStableCertificate(identity) {
		t.Fatalf("self-signed certificate not recognised: %+v", identity)
	}
	// A certificate without a leaf hash, or one pinning the binary hash, is
	// not a stable identity.
	for _, requirement := range []string{
		`identifier "com.pairfob.daemon"`,
		`identifier "com.pairfob.daemon" and cdhash H"123"`,
	} {
		identity.requirement = requirement
		if macStableCertificate(identity) {
			t.Fatalf("unstable requirement accepted: %s", requirement)
		}
	}
}
