package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Change statistics tell a review list what the status alone cannot: how many
// lines each layer of a change adds and removes, and when the file last
// changed on disk. They cost two more git reads and one stat per change, so
// they are only gathered for a client that asks (GitStatus stats:true,
// GetConfig.capabilities.git_change_stats); older clients reject unknown keys.

// MaxUntrackedCounted bounds how many untracked files are read to count their
// lines. Git reports no numstat for them; the rest go without a count.
const MaxUntrackedCounted = 64

const maxNumstatBytes = 1024 * 1024

// LineCount is the size of one layer of a change. A binary change has no
// lines to count.
type LineCount struct {
	Additions int  `json:"additions"`
	Deletions int  `json:"deletions"`
	Binary    bool `json:"binary,omitempty"`
}

// ChangeStat holds the counts for the layers a change has.
type ChangeStat struct {
	Staged   *LineCount `json:"staged,omitempty"`
	Worktree *LineCount `json:"worktree,omitempty"`
}

// parseNumstat reads `git diff --numstat -z`. A plain record is
// "added\tdeleted\tpath"; a rename has an empty path there and is followed by
// the old and the new path as records of their own. Counts are keyed by the
// path the change has now, in the workspace. Output that was cut ends in a
// record that cannot be trusted, so it is dropped.
func parseNumstat(data []byte, cut bool, repo repositoryState) map[string]LineCount {
	counts := map[string]LineCount{}
	records := strings.Split(string(data), "\x00")
	if cut && len(records) > 0 {
		records = records[:len(records)-1]
	}
	for index := 0; index < len(records); index++ {
		fields := strings.SplitN(records[index], "\t", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		if path == "" {
			if index+2 >= len(records) {
				break
			}
			path = records[index+2]
			index += 2
		}
		clean, err := cleanRelative(filepathSlash(path))
		if err != nil {
			continue
		}
		clean, inside := repo.inWorkspace(clean)
		if !inside {
			continue
		}
		if fields[0] == "-" || fields[1] == "-" {
			counts[clean] = LineCount{Binary: true}
			continue
		}
		additions, addErr := strconv.Atoi(fields[0])
		deletions, delErr := strconv.Atoi(fields[1])
		if addErr != nil || delErr != nil || additions < 0 || deletions < 0 {
			continue
		}
		counts[clean] = LineCount{Additions: additions, Deletions: deletions}
	}
	return counts
}

// untrackedCount counts the lines of a file Git does not track yet, the way
// its diff is drawn: every line is an addition. A file too large to be read
// as a diff is left without a count.
func untrackedCount(root, relative string) (LineCount, bool) {
	// Same authorized open as a preview: a symlink swapped in after a separate
	// check can never redirect the count outside the workspace.
	file, dir, ident, err := openAuthorizedRegular(root, relative)
	if err != nil {
		return LineCount{}, false
	}
	defer file.Close()
	defer dir.Close()
	if ident.info.Size() > MaxDiffBytes {
		return LineCount{}, false
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxDiffBytes+1))
	if err != nil || len(data) > MaxDiffBytes {
		return LineCount{}, false
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return LineCount{Binary: true}, true
	}
	if len(data) == 0 {
		return LineCount{}, true
	}
	lines := bytes.Count(data, []byte("\n"))
	if data[len(data)-1] != '\n' {
		lines++
	}
	return LineCount{Additions: lines}, true
}

func numstat(repo repositoryState, staged bool) (map[string]LineCount, []byte) {
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--numstat", "-z"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", ".")
	data, cut, err := runGit(repo.workspace, maxNumstatBytes, args...)
	if err != nil {
		return map[string]LineCount{}, nil
	}
	return parseNumstat(data, cut, repo), data
}

// unmerged reports a change both sides of a merge touched. Its index holds the
// sides, not a version of the file, so it has no staged layer to count.
func unmerged(change Change) bool {
	return change.Index == "U" || change.Worktree == "U" ||
		(change.Index == "A" && change.Worktree == "A") || (change.Index == "D" && change.Worktree == "D")
}

// StatusWithStats is Status with each change's line counts and modification
// time. Its revision also covers those, so a file edited again while it stays
// "modified" reads as a new status.
//
// The counts and times ride on a list that already fills its share of one
// reply. Once they would take it past that, the rest of the changes go without
// them: the list itself is never cut for their sake.
func (i *Inspector) StatusWithStats(root string) (Status, error) {
	repo, err := i.repository(root)
	if err != nil {
		return Status{}, err
	}
	status, err := repo.status()
	if err != nil {
		return Status{}, err
	}
	staged, stagedRaw := numstat(repo, true)
	worktree, worktreeRaw := numstat(repo, false)
	hash := sha256.New()
	_, _ = hash.Write([]byte(status.Revision))
	_, _ = hash.Write(stagedRaw)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(worktreeRaw)
	plain := make([]int, len(status.Changes))
	encodedSize := 0
	for index, change := range status.Changes {
		plain[index] = encodedJSONSize(change)
		encodedSize += plain[index]
	}
	untracked := 0
	for index := range status.Changes {
		change := &status.Changes[index]
		stat := ChangeStat{}
		if count, ok := staged[change.Path]; ok && !unmerged(*change) {
			stat.Staged = &count
		}
		if count, ok := worktree[change.Path]; ok {
			stat.Worktree = &count
		} else if change.Index == "?" && change.Worktree == "?" && untracked < MaxUntrackedCounted {
			untracked++
			if count, ok := untrackedCount(repo.workspace, change.Path); ok {
				stat.Worktree = &count
			}
		}
		if stat.Staged != nil || stat.Worktree != nil {
			change.Stat = &stat
		}
		// A time before 1970 is a clock's mistake, not a time to show.
		if info, statErr := os.Lstat(filepath.Join(repo.workspace, filepath.FromSlash(change.Path))); statErr == nil && info.ModTime().UnixMilli() >= 0 {
			modified := info.ModTime().UnixMilli()
			change.ModifiedMS = &modified
		}
		grown := encodedJSONSize(*change) - plain[index]
		if encodedSize+grown > MaxResultJSONBytes {
			change.Stat, change.ModifiedMS = nil, nil
			break
		}
		encodedSize += grown
		if change.ModifiedMS != nil {
			_, _ = hash.Write([]byte(change.Path))
			_, _ = hash.Write([]byte(strconv.FormatInt(*change.ModifiedMS, 10)))
			if stat.Worktree != nil {
				_, _ = hash.Write([]byte(strconv.Itoa(stat.Worktree.Additions) + ":" + strconv.Itoa(stat.Worktree.Deletions)))
			}
		}
	}
	status.Revision = hex.EncodeToString(hash.Sum(nil))
	return status, nil
}
