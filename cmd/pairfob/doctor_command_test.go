package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorCommandRejectsUnknownFlag(t *testing.T) {
	for _, args := range [][]string{
		{"--nope"},
		{"--json", "extra"},
		{"--bundle", "--out"},
	} {
		if err := doctorCommand(args, ""); err == nil {
			t.Fatalf("doctorCommand(%q) accepted bad arguments", args)
		}
	}
}

func TestDoctorJSONReturnsErrDoctorWhenStopped(t *testing.T) {
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	var out bytes.Buffer
	err := doctorJSON(&out, filepath.Join(t.TempDir(), "missing.sock"))
	if !errors.Is(err, errDoctor) {
		t.Fatalf("err = %v, want errDoctor", err)
	}
	if !strings.HasSuffix(out.String(), "\n") {
		t.Fatalf("output is not newline terminated: %q", out.String())
	}
	var report struct {
		OK      bool `json:"ok"`
		Running bool `json:"running"`
	}
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("report is not JSON: %v\n%s", err, out.String())
	}
	if report.OK || report.Running {
		t.Fatalf("report = %+v, want a stopped report", report)
	}
}
