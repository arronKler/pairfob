package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
)

// parseStatus reads `git status --porcelain=v1 -z`. Git names each path from
// the repository's top; a change is kept under its path in the workspace.
func parseStatus(data []byte, repo repositoryState) ([]Change, bool) {
	records := strings.Split(string(data), "\x00")
	outputTruncated := len(data) > 0 && data[len(data)-1] != 0
	if outputTruncated {
		records = records[:len(records)-1]
	}
	changes := make([]Change, 0, min(len(records), MaxStatusEntries))
	truncated := outputTruncated
	encodedSize := 0
	for index := 0; index < len(records); index++ {
		record := records[index]
		if record == "" {
			continue
		}
		if len(record) < 4 || record[2] != ' ' {
			continue
		}
		renamed := record[0] == 'R' || record[0] == 'C' || record[1] == 'R' || record[1] == 'C'
		path, pathErr := cleanRelative(filepathSlash(record[3:]))
		inside := false
		if pathErr == nil {
			path, inside = repo.inWorkspace(path)
		}
		if !inside {
			truncated = true
			// The record after a rename is its old path, not a change.
			if renamed && index+1 < len(records) {
				index++
			}
			continue
		}
		change := Change{Index: record[:1], Worktree: record[1:2], Path: path}
		if renamed {
			if index+1 >= len(records) || records[index+1] == "" {
				truncated = true
				continue
			}
			original, originalErr := cleanRelative(filepathSlash(records[index+1]))
			if originalErr != nil || original == "" {
				truncated = true
				index++
				continue
			}
			// A file that came from outside the workspace has no old path in it.
			if original, inside = repo.inWorkspace(original); inside {
				change.OriginalPath = &original
			}
			index++
		}
		if len(changes) == MaxStatusEntries {
			truncated = true
			break
		}
		nextSize := encodedJSONSize(change)
		if len(changes) > 0 && encodedSize+nextSize > MaxResultJSONBytes {
			truncated = true
			break
		}
		changes = append(changes, change)
		encodedSize += nextSize
	}
	return changes, truncated
}

// filepathSlash converts this platform's separators for Git paths. Git emits
// `/` on every platform, so on Unix it is identity and a literal backslash in
// a filename survives.
func filepathSlash(value string) string {
	return filepath.ToSlash(value)
}

func (i *Inspector) Status(root string) (Status, error) {
	repo, err := i.repository(root)
	if err != nil {
		return Status{}, err
	}
	return repo.status()
}

func (repo repositoryState) status() (Status, error) {
	data, outputTruncated, err := runGit(repo.workspace, 1024*1024, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".")
	if err != nil {
		return Status{}, err
	}
	changes, itemTruncated := parseStatus(data, repo)
	upstream := optionalGitLine(repo.workspace, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	ahead, behind := aheadBehind(repo.workspace)
	hash := sha256.New()
	_, _ = hash.Write([]byte(repo.head))
	_, _ = hash.Write(data)
	return Status{
		Branch: repo.branch, Head: repo.head, Upstream: upstream, Ahead: ahead, Behind: behind,
		Changes: changes, Truncated: outputTruncated || itemTruncated, Revision: hex.EncodeToString(hash.Sum(nil)),
	}, nil
}
