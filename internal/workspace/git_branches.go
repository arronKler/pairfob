package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const maxBranches = 400

func (i *Inspector) Branches(root string) (Branches, error) {
	repo, err := i.repository(root)
	if err != nil {
		return Branches{}, err
	}
	data, outputTruncated, err := runGit(repo.workspace, 512*1024,
		"for-each-ref", "--sort=-committerdate",
		"--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return Branches{}, err
	}
	items := make([]Branch, 0)
	truncated := outputTruncated
	encodedSize := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		fields := strings.Split(line, "\x00")
		if len(fields) != 5 || fields[1] == "" || strings.HasSuffix(fields[0], "/HEAD") {
			continue
		}
		if len(items) == maxBranches {
			truncated = true
			break
		}
		kind := "local"
		if strings.HasPrefix(fields[0], "refs/remotes/") {
			kind = "remote"
		}
		var upstream *string
		if fields[3] != "" {
			value := fields[3]
			upstream = &value
		}
		item := Branch{Name: fields[1], Kind: kind, Current: fields[4] == "*", Head: fields[2], Upstream: upstream}
		nextSize := encodedJSONSize(item)
		if len(items) > 0 && encodedSize+nextSize > MaxResultJSONBytes {
			truncated = true
			break
		}
		items = append(items, item)
		encodedSize += nextSize
	}
	sum := sha256.Sum256(data)
	return Branches{Items: items, Truncated: truncated, Revision: hex.EncodeToString(sum[:])}, nil
}
