package workspace

import (
	"errors"
	"os"
)

// mediaOpenHook is a test seam invoked immediately before the root-relative open.
var mediaOpenHook func(stage, relative string)

func openAuthorizedRegular(root, relative string) (*os.File, *os.Root, mediaIdentity, error) {
	canon, err := canonicalRoot(root)
	if err != nil {
		return nil, nil, mediaIdentity{}, err
	}
	clean, err := cleanRelative(relative)
	if err != nil || clean == "" {
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	dir, err := os.OpenRoot(canon)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, mediaIdentity{}, ErrNotFound
		}
		return nil, nil, mediaIdentity{}, err
	}
	// Explicit leaf policy before any read. os.Root.OpenFile with O_NOFOLLOW
	// still follows a root-contained *relative* symlink (it only rejects escapes
	// and absolute links), so an O_NOFOLLOW flag alone cannot express "the leaf
	// itself must be a regular file". Lstat the root-relative name and reject a
	// symlink or any non-regular leaf up front. Root confinement is a separate
	// os.Root guarantee and is unchanged.
	pre, err := dir.Lstat(clean)
	if err != nil {
		_ = dir.Close()
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, mediaIdentity{}, ErrNotFound
		}
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	if pre.Mode()&os.ModeSymlink != 0 || !pre.Mode().IsRegular() {
		_ = dir.Close()
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	if mediaOpenHook != nil {
		mediaOpenHook("pre-open", clean)
	}
	file, err := dir.OpenFile(clean, os.O_RDONLY|openNoFollowNonblock(), 0)
	if err != nil {
		_ = dir.Close()
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, mediaIdentity{}, ErrNotFound
		}
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	_ = file.Fd()
	st, err := file.Stat()
	if err != nil {
		_ = file.Close()
		_ = dir.Close()
		return nil, nil, mediaIdentity{}, err
	}
	if !st.Mode().IsRegular() {
		_ = file.Close()
		_ = dir.Close()
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	// Final name/descriptor identity check for the pre-open swap seam: a
	// concurrent replacement that turned the leaf into a relative symlink after
	// the Lstat above would have OpenFile follow to a different inode (or leave a
	// symlink at the name). Re-Lstat the current name and require it to be the
	// same regular file the descriptor refers to.
	named, err := dir.Lstat(clean)
	if err != nil {
		_ = file.Close()
		_ = dir.Close()
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, mediaIdentity{}, ErrNotFound
		}
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	if named.Mode()&os.ModeSymlink != 0 || !named.Mode().IsRegular() || !os.SameFile(named, st) {
		_ = file.Close()
		_ = dir.Close()
		return nil, nil, mediaIdentity{}, ErrInvalidPath
	}
	return file, dir, mediaIdentity{root: canon, clean: clean, info: st}, nil
}
