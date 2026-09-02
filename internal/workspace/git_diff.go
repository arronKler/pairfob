package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func diffStats(patch string) (int, int, bool) {
	additions, deletions := 0, 0
	binary := strings.Contains(patch, "Binary files ") || strings.Contains(patch, "GIT binary patch")
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++"):
			additions++
		case strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---"):
			deletions++
		}
	}
	return additions, deletions, binary
}

func untrackedPatch(root, relative string) (string, bool, bool, error) {
	root, _, resolved, err := resolveExisting(root, relative)
	if err != nil {
		return "", false, false, err
	}
	path := filepath.Join(root, filepath.FromSlash(relative))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false, false, err
	}
	file, err := os.Open(resolved)
	if err != nil {
		return "", false, false, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxDiffBytes+1))
	if err != nil {
		return "", false, false, err
	}
	readTruncated := len(data) > MaxDiffBytes
	if readTruncated {
		data = data[:MaxDiffBytes]
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return fmt.Sprintf("diff --git a/%s b/%s\nnew file mode 100644\nBinary files /dev/null and b/%s differ\n", relative, relative, relative), true, readTruncated || info.Size() > MaxDiffBytes, nil
	}
	lines := []string{}
	if len(data) > 0 {
		lines = strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	}
	var builder strings.Builder
	_, _ = fmt.Fprintf(&builder, "diff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n", relative, relative, relative, len(lines))
	for _, line := range lines {
		builder.WriteByte('+')
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	patch := builder.String()
	truncated := readTruncated || info.Size() > MaxDiffBytes || len(patch) > MaxDiffBytes
	if len(patch) > MaxDiffBytes {
		patch = patch[:MaxDiffBytes]
		for len(patch) > 0 && !utf8.ValidString(patch) {
			patch = patch[:len(patch)-1]
		}
	}
	var encodedTruncated bool
	patch, encodedTruncated = truncateJSONText(patch, MaxResultJSONBytes)
	truncated = truncated || encodedTruncated
	return patch, false, truncated, nil
}

func isUntracked(changes []Change, path string) bool {
	for _, change := range changes {
		if change.Path == path && change.Index == "?" && change.Worktree == "?" {
			return true
		}
	}
	return false
}

func (i *Inspector) Diff(root, relative, layer string) (Diff, error) {
	root, clean, err := validateGitPath(root, relative)
	if err != nil || (layer != "worktree" && layer != "staged") {
		if err == nil {
			err = ErrInvalidPath
		}
		return Diff{}, err
	}
	repo, err := i.repository(root)
	if err != nil {
		return Diff{}, err
	}
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"}
	if layer == "staged" {
		args = append(args, "--cached")
	}
	args = append(args, "--", ":(literal)"+clean)
	data, truncated, err := runGit(repo.workspace, MaxDiffBytes, args...)
	if err != nil {
		return Diff{}, err
	}
	patch := string(data)
	patch, encodedTruncated := truncateJSONText(patch, MaxResultJSONBytes)
	truncated = truncated || encodedTruncated
	binary := false
	if patch == "" && layer == "worktree" {
		status, statusErr := i.Status(root)
		if statusErr == nil && isUntracked(status.Changes, clean) {
			patch, binary, truncated, err = untrackedPatch(root, clean)
			if err != nil {
				return Diff{}, err
			}
		}
	}
	additions, deletions, patchBinary := diffStats(patch)
	binary = binary || patchBinary
	sum := sha256.Sum256([]byte(repo.head + "\x00" + layer + "\x00" + clean + "\x00" + patch))
	return Diff{
		Path: clean, Layer: layer, Patch: patch, Additions: additions, Deletions: deletions,
		Binary: binary, Truncated: truncated, Revision: hex.EncodeToString(sum[:]),
	}, nil
}
