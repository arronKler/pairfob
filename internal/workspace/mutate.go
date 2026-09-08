package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

var ErrConflict = errors.New("file changed or destination exists")
var ErrMutationUnknown = errors.New("file operation outcome is unknown")

// MutateFile pins the parent directory before touching a name. All path
// components must be ordinary directories; symlinks and Git metadata are excluded.
func MutateFile(root, expectedRoot, relative, newName, revision string, size, modifiedMS int64, rename bool) error {
	canonical, err := canonicalRoot(root)
	if err != nil {
		return err
	}
	if canonical != expectedRoot {
		return ErrInvalidPath
	}
	clean, err := cleanRelative(relative)
	if err != nil || clean == "" || clean != relative || strings.Contains(relative, "\\") {
		return ErrInvalidPath
	}
	components := strings.Split(clean, "/")
	for _, component := range components {
		if strings.EqualFold(component, ".git") {
			return ErrInvalidPath
		}
	}
	if rename {
		name, nameErr := cleanRelative(newName)
		if strings.EqualFold(newName, ".git") || nameErr != nil || name == "" || name != newName || strings.ContainsAny(newName, "/\\") || len(newName) > 255 {
			return ErrInvalidPath
		}
	}
	dir, err := os.Open(string(filepath.Separator))
	if err != nil {
		return err
	}
	defer func() { dir.Close() }()
	// Resolve even the canonical absolute root by descriptor: a parent replaced
	// with a symlink after canonicalization must not redirect the mutation.
	parents := append(strings.Split(strings.TrimPrefix(canonical, "/"), "/"), components[:len(components)-1]...)
	for _, component := range parents {
		if component == "" {
			continue
		}
		fd, openErr := unix.Openat(int(dir.Fd()), component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr != nil {
			return ErrInvalidPath
		}
		next := os.NewFile(uintptr(fd), component)
		dir.Close()
		dir = next
	}
	name := filepath.Base(clean)
	var stat unix.Stat_t
	if err := unix.Fstatat(int(dir.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return ErrInvalidPath
	}
	if revision != fileRevision(uint64(stat.Dev), uint64(stat.Ino), stat.Size, stat.Mtim.Sec, stat.Mtim.Nsec) || stat.Size != size || stat.Mtim.Sec*1000+stat.Mtim.Nsec/1_000_000 != modifiedMS {
		return ErrConflict
	}
	if rename && name == newName {
		return ErrConflict
	}
	err = mutateFileAt(int(dir.Fd()), name, newName, rename)
	if errors.Is(err, unix.EIO) || errors.Is(err, unix.ESTALE) {
		return errors.Join(ErrMutationUnknown, err)
	}
	return err
}
