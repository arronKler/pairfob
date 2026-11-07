package pairfob_test

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The scan keeps private data out of this public repository. A finding names
// the file, the line and a fixed kind word, never the matched text, because
// CI logs of a public repository are public.

const (
	kindPath    = "path"
	kindEmail   = "email"
	kindTailnet = "tailnet"

	allowFile    = "testdata/privacy_allow.txt"
	selfFile     = "privacy_test.go"
	maxScanBytes = 1 << 20
	nulProbe     = 8000
)

var (
	segmentRe = regexp.MustCompile(`(?:^|[^A-Za-z0-9_.-])(?:/Us` + `ers|/ho` + `me|/Vol` + `umes)/([^/\s"'` + "`" + `]+)`)
	emailRe   = regexp.MustCompile(`(?i)[a-z0-9._%+-]+@(?:gmail\.com|googlemail\.com|126\.com|163\.com|qq\.com|foxmail\.com|outlook\.com|hotmail\.com|live\.com|icloud\.com|me\.com|yahoo\.com|sina\.com|aliyun\.com)\b`)
	tailnetRe = regexp.MustCompile(`(?i)((?:[a-z0-9-]+\.)+)ts\.net\b`)
)

// privacyKinds returns the kinds of private data found in one line.
func privacyKinds(line string, allowedSegments map[string]bool) []string {
	var kinds []string
	for _, m := range segmentRe.FindAllStringSubmatch(line, -1) {
		if !allowedSegments[strings.TrimRight(m[1], ":;,.)")] {
			kinds = append(kinds, kindPath)
			break
		}
	}
	if emailRe.MatchString(line) {
		kinds = append(kinds, kindEmail)
	}
	for _, m := range tailnetRe.FindAllStringSubmatch(line, -1) {
		host := strings.ToLower(strings.TrimSuffix(m[1], "."))
		if host != "example" && !strings.HasSuffix(host, ".example") {
			kinds = append(kinds, kindTailnet)
			break
		}
	}
	return kinds
}

func TestPrivacyPatterns(t *testing.T) {
	t.Parallel()
	allow := map[string]bool{"me": true}
	cases := []struct {
		line string
		want []string
	}{
		{"/Us" + "ers/alice/proj", []string{kindPath}},
		{"/ho" + "me/bob/x", []string{kindPath}},
		{"/Vol" + "umes/data/x", []string{kindPath}},
		{"someone" + "@gmail.com", []string{kindEmail}},
		{"someone" + "@126.com", []string{kindEmail}},
		{"mac.tail1234" + ".ts.net", []string{kindTailnet}},
		{"/Us" + "ers/me/x", nil},
		{"a" + "@example.com", nil},
		{"noreply" + "@anthropic.com", nil},
		{"123+x" + "@users.noreply.github.com", nil},
		{"desk.example" + ".ts.net", nil},
		{"/us" + "ers/alice/x", nil},
	}
	for _, c := range cases {
		got := privacyKinds(c.line, allow)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("case %q: got %v want %v", c.line, got, c.want)
		}
	}
}

// loadAllow reads bare segment names and "<file>:<kind>" entries.
func loadAllow(t *testing.T, root string) (map[string]bool, map[string]bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, allowFile))
	if err != nil {
		t.Fatalf("read allow file: %v", err)
	}
	segments, fileKinds := map[string]bool{}, map[string]bool{}
	for _, raw := range strings.Split(string(data), "\n") {
		e := strings.TrimSpace(raw)
		if e == "" || strings.HasPrefix(e, "#") {
			continue
		}
		if strings.Contains(e, ":") {
			fileKinds[e] = true
		} else {
			segments[e] = true
		}
	}
	return segments, fileKinds
}

func TestNoPrivateDataInTrackedFiles(t *testing.T) {
	t.Parallel()
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skipf("not a git checkout: %v", err)
	}
	root := strings.TrimSpace(string(out))
	list, err := exec.Command("git", "-C", root, "ls-files", "-z").Output()
	if err != nil {
		t.Fatalf("git ls-files: %v", err)
	}
	segments, fileKinds := loadAllow(t, root)
	var findings []string
	for _, rel := range strings.Split(string(list), "\x00") {
		if rel == "" || rel == selfFile || rel == allowFile {
			continue
		}
		path := filepath.Join(root, rel)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxScanBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		probe := data
		if len(probe) > nulProbe {
			probe = probe[:nulProbe]
		}
		if bytes.IndexByte(probe, 0) >= 0 {
			continue
		}
		for i, line := range strings.Split(string(data), "\n") {
			for _, kind := range privacyKinds(line, segments) {
				if fileKinds[rel+":"+kind] {
					continue
				}
				findings = append(findings, fmt.Sprintf("%s:%d: %s", rel, i+1, kind))
			}
		}
	}
	sort.Strings(findings)
	if len(findings) > 0 {
		t.Errorf("private data in tracked files:\n%s", strings.Join(findings, "\n"))
	}
}

func TestPrivacyPathWithoutTrailingSlash(t *testing.T) {
	t.Parallel()
	for _, line := range []string{"HOME=/Us" + "ers/alice", "cd /ho" + "me/bob && ls", "\"/Vol" + "umes/data\""} {
		if got := privacyKinds(line, map[string]bool{"me": true}); len(got) == 0 {
			t.Errorf("case %q: got no finding, want path", line)
		}
	}
}
