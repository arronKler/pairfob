//go:build unix

package workspace

import (
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// AttachCompletedBytes returns the total size, in bytes, of all regular files
// in the controlled attachment tree under root, following no symlinks. It is
// used to enforce the per-root completed-storage quota and counts only the
// final tree (the temp-directory base of the root), never staging. The scan fails closed: any unreadable directory,
// stat error or over-limit entry count aborts with an error rather than
// undercounting. Directory reads are paginated and depth-bounded.
func AttachCompletedBytes(root string) (int64, error) {
	canon, err := canonicalRoot(root)
	if err != nil {
		return 0, err
	}
	baseFD, err := openAttachBase(canon, false)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return 0, nil
		}
		return 0, err
	}
	defer unix.Close(baseFD)
	budget := attachScanEntryLimit
	return countAttachTree(baseFD, 0, &budget)
}

// countAttachTree sums regular-file sizes under dirFD without following
// symlinks, with paginated reads, bounded depth and a bounded total entry
// count (D13 cap 16384, shared across the whole scan so nesting cannot
// multiply it). skipStage avoids recursing into .staging (the completed
// quota covers only published files, not in-flight staging).
func countAttachTree(dirFD int, depth int, budget *int) (int64, error) {
	if depth > attachScanDepthLimit {
		return 0, ErrTooLarge
	}
	fd, err := unix.Dup(dirFD)
	if err != nil {
		return 0, err
	}
	dir := os.NewFile(uintptr(fd), ".")
	if dir == nil {
		return 0, ErrInvalidPath
	}
	defer dir.Close()
	var total int64
	// Paginated directory reads: never one unbounded Readdirnames(-1).
	for {
		names, err := dir.Readdirnames(1024)
		if err != nil && err != io.EOF {
			return 0, err
		}
		if len(names) == 0 && err == io.EOF {
			break
		}
		for _, name := range names {
			if name == "." || name == ".." {
				continue
			}
			if depth == 0 && name == ".staging" {
				continue
			}
			*budget--
			if *budget < 0 {
				return 0, ErrTooLarge
			}
			var st unix.Stat_t
			if unix.Fstatat(dirFD, name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
				return 0, ErrInvalidPath
			}
			switch st.Mode & unix.S_IFMT {
			case unix.S_IFREG:
				total += st.Size
			case unix.S_IFDIR:
				sub, err := openDfd(dirFD, name)
				if err != nil {
					return 0, err
				}
				subTotal, err := countAttachTree(sub, depth+1, budget)
				_ = unix.Close(sub)
				if err != nil {
					return 0, err
				}
				total += subTotal
			default:
				// Symlinks and other node types are not followed and not
				// counted; their presence is not an error.
			}
		}
		if err == io.EOF {
			break
		}
	}
	return total, nil
}

// AttachCleanupExpired lazily removes staging dirs older than olderAgo
// seconds that carry a validated `.owned` marker (magic/version plus the
// expected controlled data name). activeIDs lists staging identities still in
// use; those dirs are never touched. It never touches the final completed
// tree or arbitrary user files; only the marker and the exact controlled data
// file named by the marker are removed, and only then is the (now-empty) dir
// rmdir'd. Unrelated files make rmdir fail and are left in place. Returns
// the number of staging dirs removed.
func AttachCleanupExpired(root string, olderAgo int64, activeIDs []string) (int, error) {
	active := make(map[string]bool, len(activeIDs))
	for _, id := range activeIDs {
		active[id] = true
	}
	canon, err := canonicalRoot(root)
	if err != nil {
		return 0, err
	}
	rootFD, err := openAttachBase(canon, false)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return 0, nil
		}
		return 0, err
	}
	defer unix.Close(rootFD)
	stageFD, err := openDirChainNoCreate(rootFD, splitRel(attachStageRel))
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return 0, nil
		}
		return 0, err
	}
	defer unix.Close(stageFD)
	names, err := readdirPaged(stageFD, 16384)
	if err != nil {
		return 0, err
	}
	now := time.Now().Unix()
	removed := 0
	for _, name := range names {
		if !attachServerID.MatchString(name) || active[name] {
			continue
		}
		var st unix.Stat_t
		if unix.Fstatat(stageFD, name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		if st.Mode&unix.S_IFMT != unix.S_IFDIR || now-st.Mtim.Sec < olderAgo {
			continue
		}
		if !cleanupStageDir(stageFD, name) {
			continue
		}
		removed++
	}
	return removed, nil
}

// readdirPaged reads all directory entry names via a dup of dirFD using
// paginated Readdirnames, failing closed on errors and over-limit entries.
func readdirPaged(dirFD int, limit int) ([]string, error) {
	fd, err := unix.Dup(dirFD)
	if err != nil {
		return nil, err
	}
	dir := os.NewFile(uintptr(fd), ".")
	if dir == nil {
		return nil, ErrInvalidPath
	}
	defer dir.Close()
	var out []string
	for {
		names, err := dir.Readdirnames(1024)
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(names) == 0 && err == io.EOF {
			break
		}
		for _, name := range names {
			if name == "." || name == ".." {
				continue
			}
			if len(out) >= limit {
				return nil, ErrTooLarge
			}
			out = append(out, name)
		}
		if err == io.EOF {
			break
		}
	}
	return out, nil
}

// cleanupStageDir validates the bounded marker (magic + version + expected
// controlled data name), removes ONLY the marker and that exact data name
// non-recursively, then rmdir's the staging dir. If any unrelated file is
// present, rmdir fails and everything else stays. Returns whether the dir
// was removed.
func cleanupStageDir(stageFD int, uuid string) bool {
	sub, err := openDfd(stageFD, uuid)
	if err != nil {
		return false
	}
	defer unix.Close(sub)
	dataName, ok := readOwnedMarker(sub)
	if !ok {
		return false
	}
	if err := unix.Unlinkat(sub, dataName, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return false
	}
	if err := unix.Unlinkat(sub, attachOwnedMark, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return false
	}
	return unix.Unlinkat(stageFD, uuid, unix.AT_REMOVEDIR) == nil
}

func dataNameCandidate(name string) bool {
	return validSafeLeaf(name) && strings.HasPrefix(name, "attachment")
}
