package workspace

import "golang.org/x/sys/unix"

func mutateFileAt(fd int, name, newName string, rename bool) error {
	if rename {
		return unix.RenameatxNp(fd, name, fd, newName, unix.RENAME_EXCL)
	}
	return unix.Unlinkat(fd, name, 0)
}
