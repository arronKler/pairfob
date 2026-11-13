package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testBool(value bool) *bool { return &value }

func TestWriteDoctorIsHuman(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{
		Version: "dev", Running: true, Phones: 2, Origin: "pairfob.com", P2P: testBool(true),
		RuntimeKind: "herdr", RuntimeOK: true, RuntimeVersion: "0.8.2", RuntimeProtocol: 20, RuntimeTerminals: 2,
	})
	got := buf.String()
	if strings.Contains(got, "{") || strings.Contains(got, "daemon_id") {
		t.Fatalf("doctor leaked internals: %s", got)
	}
	if !strings.Contains(got, "Running") || !strings.Contains(got, "Paired") || !strings.Contains(got, "Runtime") || !strings.Contains(got, "Origin") || !strings.Contains(got, "P2P") {
		t.Fatalf("doctor missing checklist: %s", got)
	}
	if !strings.Contains(got, "Runtime     herdr 0.8.2, protocol 20, 2 terminals") {
		t.Fatalf("doctor missing runtime status: %s", got)
	}
	if !strings.Contains(got, "P2P         on") {
		t.Fatalf("doctor missing P2P on: %s", got)
	}
}

func TestWriteDoctorSanitizesOriginNote(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{
		Version: "dev", Origin: "pairfob.com",
		OriginNote: `v2 relay.json url must contain daemon_id=d_abc {"reconnect_token":"rt_x"}`,
	})
	got := buf.String()
	assertOperatorText(t, got)
	if strings.Contains(got, "daemon_id") || strings.Contains(got, "reconnect_token") || strings.Contains(got, "{") {
		t.Fatalf("doctor leaked internals: %s", got)
	}
	if !strings.Contains(got, "Origin") || !strings.Contains(got, "incomplete") {
		t.Fatalf("doctor missing sanitized origin note: %s", got)
	}
}

func TestRelayHostFollowsTheEnrolledOrigin(t *testing.T) {
	for _, test := range []struct{ origin, want string }{
		{"https://relay.example.com", "relay.example.com"},
		{"http://127.0.0.1:8787", "127.0.0.1:8787"},
		{"", "pairfob.com"},
	} {
		if got := relayHost(test.origin); got != test.want {
			t.Fatalf("relayHost(%q) = %q, want %q", test.origin, got, test.want)
		}
	}
}

func TestWriteDoctorP2POff(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev", P2P: testBool(false)})
	if !strings.Contains(buf.String(), "off — this computer is relay-only") {
		t.Fatalf("%s", buf.String())
	}
}

func TestWriteDoctorP2PUnknown(t *testing.T) {
	var buf bytes.Buffer
	writeDoctor(&buf, health{Version: "dev"})
	if !strings.Contains(buf.String(), "unknown — restart Pairfob to check") {
		t.Fatalf("%s", buf.String())
	}
}

func TestWriteDoctorRuntimeStates(t *testing.T) {
	for _, tc := range []struct {
		name string
		h    health
		want string
	}{
		{
			name: "core ready",
			h:    health{RuntimeKind: "herdr-core", RuntimeOK: true, RuntimeVersion: "0.9.1", RuntimeProtocol: 1, RuntimeTerminals: 1},
			want: "Runtime     herdr-core 0.9.1, protocol 1, 1 terminal",
		},
		{
			name: "core unavailable",
			h:    health{RuntimeKind: "herdr-core", RuntimeNote: "unavailable — herdr-core did not answer"},
			want: "Runtime     herdr-core — unavailable — herdr-core did not answer",
		},
		{
			name: "herdr missing",
			h:    health{RuntimeKind: "herdr", RuntimeNote: "not installed — run pairfob setup"},
			want: "Runtime     herdr — not installed — run pairfob setup",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			writeDoctor(&buf, tc.h)
			if !strings.Contains(buf.String(), tc.want) {
				t.Fatalf("missing %q in %s", tc.want, buf.String())
			}
		})
	}
}

func TestDoctorDistinguishesInstalledAndRunningVersions(t *testing.T) {
	var out bytes.Buffer
	writeDoctor(&out, health{Version: "v1.1.0", Running: true, RunningVersion: "0027625", RunningPID: 42, ProcessNote: "installed and running programs differ"})
	for _, want := range []string{"Installed   v1.1.0", "Process     0027625 (PID 42)", "programs differ"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}

func TestDoctorServiceRecoveryVariants(t *testing.T) {
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		t.Fatalf("rendering doctor queried service: %v", args)
		return nil, nil
	})
	for _, test := range []struct {
		hint   serviceRecoveryHint
		advice string
	}{
		{serviceRecoveryHint{"service not installed", "pairfob service install"}, "Install the login service: pairfob service install"},
		{serviceRecoveryHint{"service stopped", "pairfob service start"}, "Start it with: pairfob service start"},
		{serviceRecoveryHint{"service running but not answering", "pairfob service restart"}, "Restart it with: pairfob service restart"},
		{serviceRecoveryHint{"service status unavailable", "pairfob service status"}, "Check the service: pairfob service status"},
		{serviceRecoveryHint{"service unavailable", "pairfob run"}, "Run it in the foreground: pairfob run"},
	} {
		hint := test.hint
		t.Run(hint.Note, func(t *testing.T) {
			var out bytes.Buffer
			writeDoctor(&out, health{Version: "dev", Recovery: hint})
			for _, want := range []string{"Running     no — " + hint.Note, test.advice} {
				if !strings.Contains(out.String(), want) {
					t.Fatalf("missing %q in %s", want, out.String())
				}
			}
		})
	}
}

func TestDoctorReportHasStableKeys(t *testing.T) {
	p2p := false
	checked := time.Date(2026, 11, 2, 3, 4, 5, 0, time.UTC)
	report := newDoctorReport(health{
		Version: "v1", Running: true, RunningVersion: "v1", RunningPID: 42,
		ProcessNote: "note", Phones: 2, RuntimeOK: true, RuntimeKind: "herdr",
		RuntimeCommand: "herdr", RuntimeNote: "ready", RuntimeVersion: "0.8.2",
		RuntimeProtocol: 20, RuntimeTerminals: 3, Enrolled: true,
		Origin: "pairfob.com", OriginNote: "not set up", P2P: &p2p,
		Recovery: serviceRecoveryHint{Note: "service stopped", Command: "pairfob service start"},
	}, 1, checked)
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"ok", "version", "running", "running_version", "pid", "process_note",
		"paired", "runtime", "enrolled", "origin", "origin_note", "p2p",
		"schema", "recovery", "checked_at",
	} {
		if _, ok := got[key]; !ok {
			t.Fatalf("report missing key %q: %s", key, body)
		}
	}
	var runtimeReport map[string]json.RawMessage
	if err := json.Unmarshal(got["runtime"], &runtimeReport); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"kind", "command", "ok", "note", "version", "protocol", "terminals"} {
		if _, ok := runtimeReport[key]; !ok {
			t.Fatalf("runtime missing key %q: %s", key, got["runtime"])
		}
	}
	var recovery map[string]json.RawMessage
	if err := json.Unmarshal(got["recovery"], &recovery); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"note", "advice"} {
		if _, ok := recovery[key]; !ok {
			t.Fatalf("recovery missing key %q: %s", key, got["recovery"])
		}
	}
	if !report.OK {
		t.Fatal("running runtime must make the check ok")
	}
	if string(got["checked_at"]) != `"2026-11-02T03:04:05Z"` {
		t.Fatalf("checked_at = %s", got["checked_at"])
	}
	if string(got["p2p"]) != "false" {
		t.Fatalf("p2p = %s", got["p2p"])
	}
}

func TestDoctorReportP2PUnknownIsNull(t *testing.T) {
	report := newDoctorReport(health{Version: "dev", RuntimeTerminals: -1}, 0, time.Now())
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"p2p":null`)) {
		t.Fatalf("missing null p2p: %s", body)
	}
	if !bytes.Contains(body, []byte(`"schema":0`)) {
		t.Fatalf("missing schema 0: %s", body)
	}
	if report.OK {
		t.Fatal("a stopped daemon is not ok")
	}
}

func TestDoctorBundleEntriesAndMode(t *testing.T) {
	stateDir := t.TempDir()
	writeStateFile(t, stateDir, "schema.json", `{"schema":1}`)
	writeStateFile(t, stateDir, "daemon.json", `{"daemon_id":"d_123","hostname":"test-host"}`)
	writeStateFile(t, stateDir, "devices.json", `[{"device_id":"a"},{"device_id":"b","revoked_at":5}]`)
	writeStateFile(t, stateDir, "audit.log", `{"op":"pair","device_psk":"psk_secret","note":"ok"}`+"\n")
	var logBody strings.Builder
	for i := 0; i < 350; i++ {
		logBody.WriteString("line ")
		logBody.WriteString(strings.Repeat("x", 3))
		logBody.WriteByte('\n')
	}
	writeStateFile(t, stateDir, "pairfob.log", logBody.String())

	out := filepath.Join(t.TempDir(), "doctor.zip")
	now := time.Date(2026, 11, 2, 3, 4, 5, 0, time.UTC)
	path, err := writeDoctorBundle(doctorBundleOptions{
		StateDir: stateDir,
		OutPath:  out,
		HomeDir:  "/Users/tester",
		Now:      now,
		Version:  "v9.1.2",
		Report:   newDoctorReport(health{Version: "v9.1.2", Origin: "pairfob.com"}, 1, now),
		Human:    []byte("Pairfob v9.1.2\n  Executable  \"/Users/tester/bin/pairfob\"\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != out {
		t.Fatalf("path = %q, want %q", path, out)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("zip mode = %o, want 0600", info.Mode().Perm())
	}

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	files := make(map[string]string, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[f.Name] = string(body)
	}
	want := []string{
		"report.json", "doctor.txt", "logs/pairfob.log.tail",
		"logs/audit.log.tail", "state/summary.json", "manifest.json",
	}
	if len(files) != len(want) {
		t.Fatalf("entries = %v", files)
	}
	for _, name := range want {
		if _, ok := files[name]; !ok {
			t.Fatalf("missing entry %q in %v", name, files)
		}
	}

	var report map[string]json.RawMessage
	if err := json.Unmarshal([]byte(files["report.json"]), &report); err != nil {
		t.Fatalf("report.json: %v", err)
	}
	if _, ok := report["runtime"]; !ok {
		t.Fatal("report.json is not the doctor report")
	}
	if strings.Contains(files["doctor.txt"], "/Users/tester") {
		t.Fatalf("home directory not redacted: %s", files["doctor.txt"])
	}
	if strings.Contains(files["logs/audit.log.tail"], "psk_secret") {
		t.Fatalf("secret not redacted: %s", files["logs/audit.log.tail"])
	}
	if got := len(strings.Split(strings.TrimSuffix(files["logs/pairfob.log.tail"], "\n"), "\n")); got != doctorBundleLines {
		t.Fatalf("log tail lines = %d, want %d", got, doctorBundleLines)
	}

	var summary struct {
		Schema   int    `json:"schema"`
		Paired   int    `json:"paired"`
		Revoked  int    `json:"revoked"`
		DaemonID string `json:"daemon_id"`
		Hostname string `json:"hostname"`
		Origin   string `json:"origin"`
	}
	if err := json.Unmarshal([]byte(files["state/summary.json"]), &summary); err != nil {
		t.Fatalf("summary.json: %v", err)
	}
	if summary.Schema != 1 || summary.Paired != 1 || summary.Revoked != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.DaemonID != "d_123" || summary.Hostname != "test-host" || summary.Origin != "pairfob.com" {
		t.Fatalf("summary = %+v", summary)
	}

	var manifest struct {
		CreatedAt      string `json:"created_at"`
		PairfobVersion string `json:"pairfob_version"`
		Files          []struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
			Size   int64  `json:"size"`
		} `json:"files"`
		Redactions []string `json:"redactions"`
	}
	if err := json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil {
		t.Fatalf("manifest.json: %v", err)
	}
	if manifest.CreatedAt != "2026-11-02T03:04:05Z" || manifest.PairfobVersion != "v9.1.2" {
		t.Fatalf("manifest = %+v", manifest)
	}
	if len(manifest.Files) != len(want)-1 {
		t.Fatalf("manifest files = %+v", manifest.Files)
	}
	for _, entry := range manifest.Files {
		if len(entry.SHA256) != 64 || entry.Size <= 0 {
			t.Fatalf("manifest entry = %+v", entry)
		}
	}
	if len(manifest.Redactions) == 0 {
		t.Fatal("manifest must record the redactions")
	}
}

func TestDoctorBundleReportRedactsEmbeddedJSON(t *testing.T) {
	now := time.Date(2026, 11, 2, 3, 4, 5, 0, time.UTC)
	out := filepath.Join(t.TempDir(), "doctor.zip")
	path, err := writeDoctorBundle(doctorBundleOptions{
		OutPath: out,
		HomeDir: "/Users/tester",
		Now:     now,
		Version: "v9.1.2",
		Report: doctorReport{
			Version:    "v9.1.2",
			Origin:     "pairfob.com",
			OriginNote: `relay said {"reconnect_token":"rt_nested"}`,
			Runtime: doctorRuntimeReport{
				Command: "/Users/tester/bin/herdr",
				Note:    `auth {"device_psk":"psk_nested"}`,
			},
			Recovery:  doctorRecoveryReport{Note: "patient_token=tok_nested"},
			CheckedAt: now.UTC().Format(time.RFC3339),
		},
		Human: []byte("Pairfob v9.1.2\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var reportJSON string
	for _, f := range zr.File {
		if f.Name != "report.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		reportJSON = string(body)
	}
	if reportJSON == "" {
		t.Fatal("report.json missing")
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal([]byte(reportJSON), &parsed); err != nil {
		t.Fatalf("report.json is not valid JSON after redaction: %v\n%s", err, reportJSON)
	}
	for _, secret := range []string{"rt_nested", "psk_nested", "tok_nested", "/Users/tester"} {
		if strings.Contains(reportJSON, secret) {
			t.Fatalf("secret %q survived in report.json: %s", secret, reportJSON)
		}
	}
}

func TestDoctorBundleSkipsMissingLogs(t *testing.T) {
	stateDir := t.TempDir()
	writeStateFile(t, stateDir, "schema.json", `{"schema":1}`)
	out := filepath.Join(t.TempDir(), "doctor.zip")
	path, err := writeDoctorBundle(doctorBundleOptions{
		StateDir: stateDir,
		OutPath:  out,
		Now:      time.Date(2026, 11, 2, 3, 4, 5, 0, time.UTC),
		Human:    []byte("Pairfob dev\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "logs/") {
			t.Fatalf("unexpected log entry %q", f.Name)
		}
	}
}

func TestDoctorBundleName(t *testing.T) {
	now := time.Date(2026, 11, 2, 3, 4, 5, 0, time.UTC)
	got := doctorBundleName("my host", now)
	if got != "pairfob-doctor-my-host-20261102T030405Z.zip" {
		t.Fatalf("name = %q", got)
	}
}

func TestDoctorRedactionRules(t *testing.T) {
	input := strings.Join([]string{
		"path=/Users/tester/.config/pairfob/pairfob.log",
		`{"reconnect_token":"rt_secret","private_key":"pk_secret","op":"pair"}`,
		"device_psk=psk_secret",
		"Authorization: Bearer abc.def.ghi",
		"patient_token: tok_123",
		"nothing to redact here",
	}, "\n")
	got := redactDoctorText(input, "/Users/tester")
	for _, secret := range []string{"rt_secret", "pk_secret", "psk_secret", "abc.def.ghi", "tok_123"} {
		if strings.Contains(got, secret) {
			t.Fatalf("secret %q survived redaction: %s", secret, got)
		}
	}
	if !strings.Contains(got, "~/.config/pairfob/pairfob.log") {
		t.Fatalf("home directory should become ~: %s", got)
	}
	if !strings.Contains(got, "nothing to redact here") {
		t.Fatalf("ordinary text was altered: %s", got)
	}
}

func writeStateFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
