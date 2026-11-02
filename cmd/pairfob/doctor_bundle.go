package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"pairfob/internal/state"
)

const doctorBundleLines = 300

type doctorBundleOptions struct {
	StateDir string
	OutPath  string
	HomeDir  string
	Now      time.Time
	Version  string
	Report   doctorReport
	Human    []byte
}

type doctorBundleEntry struct {
	Name string
	Body string
}

type doctorBundleFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type doctorBundleManifest struct {
	CreatedAt      string             `json:"created_at"`
	PairfobVersion string             `json:"pairfob_version"`
	Files          []doctorBundleFile `json:"files"`
	Redactions     []string           `json:"redactions"`
}

type doctorStateSummary struct {
	Schema   int    `json:"schema"`
	Paired   int    `json:"paired"`
	Revoked  int    `json:"revoked"`
	DaemonID string `json:"daemon_id"`
	Hostname string `json:"hostname"`
	Origin   string `json:"origin"`
}

func doctorBundleCommand(args []string, sock string) error {
	out := ""
	switch {
	case len(args) == 0:
	case len(args) == 2 && args[0] == "--out" && args[1] != "":
		out = args[1]
	default:
		return doctorUsage()
	}
	h, report := doctorReportFor(sock)
	var human bytes.Buffer
	renderDoctorHuman(&human, h, sock)
	path, err := writeDoctorBundle(doctorBundleOptions{
		StateDir: doctorStateDir(),
		OutPath:  out,
		HomeDir:  homeDir(),
		Now:      time.Now(),
		Version:  version,
		Report:   report,
		Human:    human.Bytes(),
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stdout, "Wrote %s\n", path)
	return nil
}

// writeDoctorBundle writes the redacted diagnostics zip locally and returns
// the path it used. It never uploads anything.
func writeDoctorBundle(opts doctorBundleOptions) (string, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	out := opts.OutPath
	if out == "" {
		out = "./" + doctorBundleName(hostname(), now)
	}

	reportJSON, err := json.MarshalIndent(redactDoctorReport(opts.Report, opts.HomeDir), "", "  ")
	if err != nil {
		return "", err
	}
	summaryJSON, err := json.MarshalIndent(stateSummaryFor(opts.StateDir, opts.Report.Origin), "", "  ")
	if err != nil {
		return "", err
	}

	entries := []doctorBundleEntry{
		{Name: "report.json", Body: redactDoctorText(string(reportJSON)+"\n", opts.HomeDir)},
		{Name: "doctor.txt", Body: redactDoctorText(string(opts.Human), opts.HomeDir)},
	}
	if opts.StateDir != "" {
		for _, log := range []struct{ path, name string }{
			{filepath.Join(opts.StateDir, "pairfob.log"), "logs/pairfob.log.tail"},
			{filepath.Join(opts.StateDir, "audit.log"), "logs/audit.log.tail"},
		} {
			body, ok, err := tailLogFile(log.path, doctorBundleLines)
			if err != nil {
				return "", err
			}
			if !ok {
				continue
			}
			entries = append(entries, doctorBundleEntry{
				Name: log.name, Body: redactDoctorText(body, opts.HomeDir),
			})
		}
	}
	entries = append(entries, doctorBundleEntry{
		Name: "state/summary.json",
		Body: redactDoctorText(string(summaryJSON)+"\n", opts.HomeDir),
	})

	manifest, err := doctorManifest(now, opts.Version, entries)
	if err != nil {
		return "", err
	}
	entries = append(entries, doctorBundleEntry{Name: "manifest.json", Body: manifest})

	if err := writeDoctorZip(out, entries); err != nil {
		return "", err
	}
	return out, nil
}

func doctorBundleName(host string, now time.Time) string {
	host = strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\' || r == ':' || unicode.IsSpace(r):
			return '-'
		default:
			return r
		}
	}, host)
	if host == "" {
		host = "unknown"
	}
	return fmt.Sprintf("pairfob-doctor-%s-%s.zip", host, now.UTC().Format("20060102T150405Z"))
}

func stateSummaryFor(dir, origin string) doctorStateSummary {
	summary := doctorStateSummary{Schema: readStateSchemaIn(dir), Origin: origin}
	if dir == "" {
		return summary
	}
	var identity struct {
		DaemonID string `json:"daemon_id"`
		Hostname string `json:"hostname"`
	}
	if readStateJSON(dir, "daemon.json", &identity) == nil {
		summary.DaemonID = identity.DaemonID
		summary.Hostname = identity.Hostname
	}
	var devices []struct {
		RevokedAt *int64 `json:"revoked_at"`
	}
	if readStateJSON(dir, "devices.json", &devices) == nil {
		for _, device := range devices {
			if device.RevokedAt == nil {
				summary.Paired++
			} else {
				summary.Revoked++
			}
		}
	}
	return summary
}

func readStateJSON(dir, name string, dst any) error {
	if dir == "" {
		return os.ErrNotExist
	}
	path := filepath.Join(dir, name)
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular file", name)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dst)
}

func tailLogFile(path string, n int) (string, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return tailLogLines(string(data), n), true, nil
}

func tailLogLines(text string, n int) string {
	if n <= 0 {
		return ""
	}
	trailing := strings.HasSuffix(text, "\n")
	if trailing {
		text = strings.TrimSuffix(text, "\n")
	}
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	body := strings.Join(lines, "\n")
	if trailing {
		body += "\n"
	}
	return body
}

func doctorManifest(now time.Time, build string, entries []doctorBundleEntry) (string, error) {
	manifest := doctorBundleManifest{
		CreatedAt:      now.UTC().Format(time.RFC3339),
		PairfobVersion: build,
		Files:          make([]doctorBundleFile, 0, len(entries)),
		Redactions: []string{
			"home directory replaced with ~",
			"secret key values replaced with [redacted]",
		},
	}
	for _, entry := range entries {
		sum := sha256.Sum256([]byte(entry.Body))
		manifest.Files = append(manifest.Files, doctorBundleFile{
			Path:   entry.Name,
			SHA256: hex.EncodeToString(sum[:]),
			Size:   int64(len(entry.Body)),
		})
	}
	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b) + "\n", nil
}

func writeDoctorZip(path string, entries []doctorBundleEntry) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(f)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.Name, Method: zip.Deflate}
		header.SetMode(0600)
		w, err := zw.CreateHeader(header)
		if err != nil {
			_ = zw.Close()
			_ = f.Close()
			return err
		}
		if _, err := io.WriteString(w, entry.Body); err != nil {
			_ = zw.Close()
			_ = f.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

var (
	doctorBearerPattern     = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+`)
	doctorJSONStringPattern = regexp.MustCompile(`(?i)("[^"]*(psk|token|secret|private|authorization|bearer)[^"]*"\s*:\s*)"[^"]*"`)
	doctorJSONScalarPattern = regexp.MustCompile(`(?i)("[^"]*(psk|token|secret|private|authorization|bearer)[^"]*"\s*:\s*)(true|false|null|-?[0-9]+(\.[0-9]+)?)`)
	doctorKeyValuePattern   = regexp.MustCompile(`(?i)([A-Za-z0-9_.-]*(psk|token|secret|private|authorization|bearer)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s,;}\]]+)`)
)

// redactDoctorReport cleans the report's string fields before serialization.
// The text pass runs on the marshaled JSON, where the marshaler has escaped
// the quotes of any JSON embedded in a note, so a nested secret would not
// match there. Cleaning the values first closes that gap.
func redactDoctorReport(r doctorReport, home string) doctorReport {
	clean := func(s string) string { return redactDoctorText(s, home) }
	r.Version = clean(r.Version)
	r.RunningVersion = clean(r.RunningVersion)
	r.ProcessNote = clean(r.ProcessNote)
	r.Runtime.Kind = clean(r.Runtime.Kind)
	r.Runtime.Command = clean(r.Runtime.Command)
	r.Runtime.Note = clean(r.Runtime.Note)
	r.Runtime.Version = clean(r.Runtime.Version)
	r.Origin = clean(r.Origin)
	r.OriginNote = clean(r.OriginNote)
	r.Recovery.Note = clean(r.Recovery.Note)
	r.Recovery.Advice = clean(r.Recovery.Advice)
	r.CheckedAt = clean(r.CheckedAt)
	return r
}

// redactDoctorText removes the local home path and any value attached to a
// secret-looking key. It is applied to every text file in the bundle.
func redactDoctorText(text, home string) string {
	if home != "" && home != string(os.PathSeparator) {
		text = strings.ReplaceAll(text, strings.TrimRight(home, string(os.PathSeparator)), "~")
	}
	text = doctorBearerPattern.ReplaceAllString(text, "bearer [redacted]")
	text = doctorJSONStringPattern.ReplaceAllString(text, `${1}"[redacted]"`)
	text = doctorJSONScalarPattern.ReplaceAllString(text, `${1}"[redacted]"`)
	text = doctorKeyValuePattern.ReplaceAllString(text, `${1}=[redacted]`)
	return text
}

func doctorStateDir() string {
	dir, err := state.DefaultDir()
	if err != nil {
		return ""
	}
	return dir
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func hostname() string {
	host, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return host
}
