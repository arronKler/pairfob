package workspace

import "golang.org/x/sys/unix"

func mutateFileAt(fd int, name, newName string, rename bool) error {
	if rename {
		return unix.Renameat2(fd, name, fd, newName, unix.RENAME_NOREPLACE)
	}
	return unix.Unlinkat(fd, name, 0)
}
