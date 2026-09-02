package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

func parseStatus(data []byte) ([]Change, bool) {
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
		path, pathErr := cleanRelative(filepathSlash(record[3:]))
		if pathErr != nil || path == "" {
			truncated = true
			continue
		}
		change := Change{Index: record[:1], Worktree: record[1:2], Path: path}
		if change.Index == "R" || change.Index == "C" || change.Worktree == "R" || change.Worktree == "C" {
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
			change.OriginalPath = &original
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

func filepathSlash(value string) string {
	return strings.ReplaceAll(value, "\\", "/")
}

func (i *Inspector) Status(root string) (Status, error) {
	repo, err := i.repository(root)
	if err != nil {
		return Status{}, err
	}
	data, outputTruncated, err := runGit(repo.workspace, 1024*1024, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".")
	if err != nil {
		return Status{}, err
	}
	changes, itemTruncated := parseStatus(data)
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
