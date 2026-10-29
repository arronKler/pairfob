package main

import (
	"errors"
	"strings"
	"testing"
)

func signatureFixture(team, id, requirement string) string {
	signature := ""
	if team == "not set" {
		signature = "Signature=adhoc\n"
	}
	return signature + "Identifier=" + id + "\nTeamIdentifier=" + team + "\ndesignated => " + requirement + "\n"
}

func TestMacUpdateIdentityContinuity(t *testing.T) {
	stable := signatureFixture("ABCDE12345", macDaemonIdentifier, `identifier "com.pairfob.daemon" and anchor apple generic`)
	releaseAdhoc := signatureFixture("not set", macDaemonIdentifier, `cdhash H"456"`)
	adhoc := signatureFixture("not set", "a.out", `cdhash H"123"`)
	for _, tc := range []struct {
		name, old, next, base, fail string
		want                        bool
	}{
		{"same identity", stable, stable, "https://dl.pairfob.com/daemon", "", true},
		{"migration", adhoc, stable, "https://dl.pairfob.com/daemon", "", true},
		{"wrong unsigned identifier", adhoc, adhoc, "https://dl.pairfob.com/daemon", "", false},
		{"public no certificate", adhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "", true},
		{"missing ad-hoc signature", adhoc, strings.ReplaceAll(releaseAdhoc, "Signature=adhoc\n", ""), "https://dl.pairfob.com/daemon", "", false},
		{"next no certificate", releaseAdhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "", true},
		{"tampered no certificate", adhoc, releaseAdhoc, "https://dl.pairfob.com/daemon", "candidate", false},
		{"signed refuses no certificate", stable, releaseAdhoc, "https://dl.pairfob.com/daemon", "", false},
		{"remote insecure", adhoc, releaseAdhoc, "http://example.com/daemon", "", false},
		{"signed to adhoc", stable, adhoc, "http://127.0.0.1:1234", "", false},
		{"other team", stable, signatureFixture("ZZZZZ12345", macDaemonIdentifier, "anchor apple"), "https://dl.pairfob.com/daemon", "", false},
		{"other identifier", stable, signatureFixture("ABCDE12345", "another.app", "anchor apple"), "https://dl.pairfob.com/daemon", "", false},
		{"hash pinned", stable, signatureFixture("ABCDE12345", macDaemonIdentifier, `cdhash H"123"`), "https://dl.pairfob.com/daemon", "", false},
		{"tampered candidate", stable, stable, "https://dl.pairfob.com/daemon", "candidate", false},
		{"tampered installed", stable, stable, "https://dl.pairfob.com/daemon", "current", false},
		{"DR changed", stable, stable, "https://dl.pairfob.com/daemon", "requirement", false},
		{"local dev", adhoc, adhoc, "http://localhost:1234", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oldRequirementChecked := false
			run := func(args ...string) ([]byte, error) {
				path := args[len(args)-1]
				if args[0] == "--display" {
					if path == "current" {
						return []byte(tc.old), nil
					}
					return []byte(tc.next), nil
				}
				if args[0] == "--verify" {
					if tc.fail == path {
						return nil, errors.New("private signing error")
					}
					if len(args) > 3 && args[3] == `=identifier "com.pairfob.daemon" and anchor apple generic` {
						oldRequirementChecked = true
						if tc.fail == "requirement" {
							return nil, errors.New("mismatch")
						}
					}
				}
				return nil, nil
			}
			err := verifyMacUpdateIdentity("current", "candidate", tc.base, run)
			if (err == nil) != tc.want {
				t.Fatalf("%v", err)
			}
			if tc.name == "same identity" && !oldRequirementChecked {
				t.Fatal("only compared team, not the installed DR")
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
