package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"pairfob/internal/pairingqr"
)

var sasUserInstruction = regexp.MustCompile(`(?i)\bSAS\b|two short words|compare the two words|两个短词|两个词（SAS）|对照两个词|PGP word`)

func TestPublicDocsDoNotAskUsersToCompareSAS(t *testing.T) {
	root := repoRoot(t)
	files := []string{
		"site/doc/start.md", "site/doc/pair.md", "site/doc/security.md", "site/doc/glossary.md", "site/doc/index.md",
		"site/doc/zh/start.md", "site/doc/zh/pair.md", "site/doc/zh/security.md", "site/doc/zh/glossary.md", "site/doc/zh/index.md",
		"cmd/pairfob/pair.go",
		"cmd/pairfob/pair_prompt.go",
	}
	for _, rel := range files {
		body, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		if loc := sasUserInstruction.FindIndex(body); loc != nil {
			t.Errorf("%s instructs SAS comparison: %s", rel, bytes.TrimSpace(body[loc[0]:loc[1]]))
		}
	}
}

func TestPairBannerAndEnterPromptHaveNoSAS(t *testing.T) {
	var out bytes.Buffer
	offer := pairingqr.Offer{Code: "7K3M9H2P", Ref: "4f7a2c9e1b0d88aa55cc3311abde7001", URL: "https://pairfob.example/pair#v=2", Loc: "WJ3K9M"}
	if err := pairingqr.Print(&out, offer, time.Minute); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if sasUserInstruction.MatchString(got) {
		t.Fatalf("QR banner mentioned SAS: %s", got)
	}
	if !strings.Contains(got, "Can't scan? Type this pairing code") {
		t.Fatalf("%s", got)
	}
	src, err := os.ReadFile(filepath.Join(repoRoot(t), "cmd/pairfob/pair_prompt.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(src, []byte("Press Enter to pair")) {
		t.Fatal("pair stdout no longer asks for Enter after proof")
	}
	if bytes.Contains(src, []byte("SAS")) {
		t.Fatal("pair_prompt.go mentioned SAS")
	}
}

func TestPairEnterPromptStandsApartFromStatusCopy(t *testing.T) {
	var out bytes.Buffer
	if err := printPairEnterPrompt(&out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if sasUserInstruction.MatchString(got) {
		t.Fatalf("enter prompt mentioned SAS: %s", got)
	}
	if strings.Contains(got, "Waiting to pair") || strings.Contains(got, "Can't scan") {
		t.Fatalf("enter prompt mixed with earlier pairing copy: %s", got)
	}
	lines := strings.Split(got, "\n")
	action := -1
	for i, line := range lines {
		if !strings.Contains(line, "Press Enter to pair") {
			continue
		}
		if action != -1 {
			t.Fatalf("action appeared more than once: %s", got)
		}
		action = i
		if strings.Contains(line, "That device is ready") || strings.Contains(line, "Paired") {
			t.Fatalf("action blended into another sentence: %q", line)
		}
		if !strings.Contains(line, ">>>") || !strings.Contains(line, "<<<") {
			t.Fatalf("non-TTY action should be marked as a CTA: %q", line)
		}
	}
	if action < 1 || action+1 >= len(lines) {
		t.Fatalf("missing standalone action: %s", got)
	}
	if strings.TrimSpace(lines[action-1]) != "" || strings.TrimSpace(lines[action+1]) != "" {
		t.Fatalf("action should sit on its own with blank lines around it: %q", got)
	}
	if !strings.Contains(got, "That device is ready.") {
		t.Fatalf("missing ready status: %s", got)
	}
	if strings.Contains(got, "\033") || strings.Contains(got, "\a") {
		t.Fatalf("piped output should stay plain text: %q", got)
	}
}

func TestPairEnterPromptDoesNotColorPlainWriters(t *testing.T) {
	if writerIsTTY(&bytes.Buffer{}) || useANSI(&bytes.Buffer{}) {
		t.Fatal("buffer looked like a TTY")
	}
	file, err := os.CreateTemp(t.TempDir(), "pair-prompt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if writerIsTTY(file) || useANSI(file) {
		t.Fatal("regular file looked like a TTY")
	}
}
