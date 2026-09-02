package workspace

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitTestRun(t *testing.T, root string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	command.Env = append(os.Environ(), "LC_ALL=C")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func gitFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	gitTestRun(t, root, "init", "-b", "main")
	gitTestRun(t, root, "config", "user.email", "pairfob@example.invalid")
	gitTestRun(t, root, "config", "user.name", "Pairfob Test")
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "staged.txt"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "tracked.txt", "staged.txt")
	gitTestRun(t, root, "commit", "-m", "base")
	return root
}

func TestGitStatusDiffAndBranches(t *testing.T) {
	root := gitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("before\nafter\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "staged.txt"), []byte("old\nstaged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "staged.txt")
	if err := os.WriteFile(filepath.Join(root, "new file.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "branch", "feature/mobile")
	head := strings.TrimSpace(gitTestRun(t, root, "rev-parse", "HEAD"))
	gitTestRun(t, root, "update-ref", "refs/remotes/origin/main", head)
	gitTestRun(t, root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	inspector := NewInspector()
	descriptor, err := inspector.Describe(root)
	if err != nil || descriptor.Git == nil || descriptor.Git.Branch == nil || *descriptor.Git.Branch != "main" || !descriptor.Features.GitDiff {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
	status, err := inspector.Status(root)
	if err != nil || len(status.Changes) != 3 || status.Branch == nil || *status.Branch != "main" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	byPath := map[string]Change{}
	for _, change := range status.Changes {
		byPath[change.Path] = change
	}
	if byPath["tracked.txt"].Worktree != "M" || byPath["staged.txt"].Index != "M" || byPath["new file.txt"].Index != "?" {
		t.Fatalf("changes=%+v", status.Changes)
	}
	worktree, err := inspector.Diff(root, "tracked.txt", "worktree")
	if err != nil || !strings.Contains(worktree.Patch, "+after") || worktree.Additions != 1 {
		t.Fatalf("worktree=%+v err=%v", worktree, err)
	}
	staged, err := inspector.Diff(root, "staged.txt", "staged")
	if err != nil || !strings.Contains(staged.Patch, "+staged") || staged.Additions != 1 {
		t.Fatalf("staged=%+v err=%v", staged, err)
	}
	untracked, err := inspector.Diff(root, "new file.txt", "worktree")
	if err != nil || !strings.Contains(untracked.Patch, "new file mode") || !strings.Contains(untracked.Patch, "+new") {
		t.Fatalf("untracked=%+v err=%v", untracked, err)
	}
	branches, err := inspector.Branches(root)
	if err != nil || len(branches.Items) != 3 {
		t.Fatalf("branches=%+v err=%v", branches, err)
	}
	current, feature, remote := false, false, false
	for _, branch := range branches.Items {
		current = current || branch.Name == "main" && branch.Current
		feature = feature || branch.Name == "feature/mobile"
		remote = remote || branch.Name == "origin/main" && branch.Kind == "remote"
		if branch.Name == "origin" {
			t.Fatal("remote HEAD pseudo-branch must stay hidden")
		}
	}
	if !current || !feature || !remote {
		t.Fatalf("branches=%+v", branches.Items)
	}
}

func TestDescribeNonRepositoryKeepsFileBrowsing(t *testing.T) {
	descriptor, err := NewInspector().Describe(t.TempDir())
	if err != nil || descriptor.Git != nil || !descriptor.Features.Files || descriptor.Features.GitStatus {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
}

func TestParseStatusDropsPartialRecords(t *testing.T) {
	changes, truncated := parseStatus([]byte(" M complete.txt\x00?? partial"))
	if !truncated || len(changes) != 1 || changes[0].Path != "complete.txt" {
		t.Fatalf("changes=%+v truncated=%v", changes, truncated)
	}
	changes, truncated = parseStatus([]byte("R  renamed.txt\x00"))
	if !truncated || len(changes) != 0 {
		t.Fatalf("partial rename changes=%+v truncated=%v", changes, truncated)
	}
	changes, truncated = parseStatus([]byte("?? line\nbreak.txt\x00"))
	if !truncated || len(changes) != 0 {
		t.Fatalf("control path changes=%+v truncated=%v", changes, truncated)
	}
}

func TestDiffStaysInsideEncryptedResponseBudget(t *testing.T) {
	root := gitFixture(t)
	content := strings.Repeat("line\n", MaxDiffBytes/5)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	diff, err := NewInspector().Diff(root, "large.txt", "worktree")
	if err != nil || !diff.Truncated {
		t.Fatalf("diff truncated=%v err=%v", diff.Truncated, err)
	}
	encoded, err := json.Marshal(diff)
	if err != nil || len(encoded) >= 240*1024 {
		t.Fatalf("encoded diff bytes=%d err=%v", len(encoded), err)
	}
}

func TestGitStderrBufferIsBounded(t *testing.T) {
	var buffer cappedBuffer
	payload := []byte(strings.Repeat("x", maxGitStderrBytes+1024))
	written, err := buffer.Write(payload)
	if err != nil || written != len(payload) || len(buffer.String()) != maxGitStderrBytes {
		t.Fatalf("written=%d buffered=%d err=%v", written, len(buffer.String()), err)
	}
}
