//go:build unix

package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const (
	attachDirMode  = 0o700
	attachFileMode = 0o600
)

var attachServerID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// attachQuotaMu serializes completed-quota check + publish for ALL roots so
// two concurrent commits cannot each pass a quota check and together push a
// root above the completed-storage limit (D13: Begin's check is advisory
// only).
var attachQuotaMu sync.Mutex

// Test seams: production defaults are the frozen constants. Focused tests
// may lower the quota or entry cap and inject failures at named points.
var (
	attachCompletedLimit int64 = AttachCompletedPerRoot
	attachScanEntryLimit       = 16384
	attachScanDepthLimit       = 4
)

// attachHook is a test seam invoked at key points between an open and the
// next operation (mirrors mediaOpenHook). Used only by security tests.
var attachHook func(stage, rel string)

func setAttachHook(fn func(stage, rel string)) func() {
	prev := attachHook
	attachHook = fn
	return func() { attachHook = prev }
}

// attachErrHook is a test seam that injects a failure at a named point
// ("post-rename-fsync"). Used only by security tests.
var attachErrHook func(stage string) error

func setAttachErrHook(fn func(stage string) error) func() {
	prev := attachErrHook
	attachErrHook = fn
	return func() { attachErrHook = prev }
}

func splitRel(rel string) []string {
	return strings.Split(rel, "/")
}

// openAttachBase opens the attachment base directory of a canonical root,
// creating it (and its parent) with mode 0700 when create is set. Every
// directory is opened O_DIRECTORY|O_NOFOLLOW and fstat-checked: owner must be
// the effective user and no group/other bits may be set, else
// ErrAttachBaseUnsafe. A missing base without create reports ENOENT.
func openAttachBase(canon string, create bool) (int, error) {
	base := attachBasePath(canon)
	parentFD, err := openCheckedDir(filepath.Dir(base), create)
	if err != nil {
		return -1, err
	}
	unix.Close(parentFD)
	return openCheckedDir(base, create)
}

func openCheckedDir(path string, create bool) (int, error) {
	if create {
		if err := unix.Mkdir(path, attachDirMode); err != nil && !errors.Is(err, unix.EEXIST) {
			return -1, err
		}
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return -1, ErrAttachBaseUnsafe
		}
		return -1, err
	}
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil {
		unix.Close(fd)
		return -1, ErrAttachBaseUnsafe
	}
	if int(st.Uid) != os.Geteuid() || st.Mode&0o077 != 0 {
		unix.Close(fd)
		return -1, ErrAttachBaseUnsafe
	}
	return fd, nil
}

// ensureDirChain walks/creates the directory components under baseFD, opening
// each with O_NOFOLLOW|O_DIRECTORY (so a symlink, including an intra-root one,
// cannot redirect the chain). Missing components are created with mkdirat and
// then reopened no-follow. Returns the fd of the final directory (caller owns
// and must close it). Intermediates are closed.
func ensureDirChain(baseFD int, components []string) (int, error) {
	cur := baseFD
	closeCur := false
	for _, comp := range components {
		if comp == "" || comp == "." || comp == ".." {
			if closeCur {
				_ = unix.Close(cur)
			}
			return -1, ErrInvalidPath
		}
		fd, err := openDfd(cur, comp)
		if err != nil {
			if !errors.Is(err, unix.ENOENT) {
				if closeCur {
					_ = unix.Close(cur)
				}
				return -1, err
			}
			if err := unix.Mkdirat(cur, comp, attachDirMode); err != nil && !errors.Is(err, unix.EEXIST) {
				if closeCur {
					_ = unix.Close(cur)
				}
				return -1, err
			}
			fd, err = openDfd(cur, comp)
			if err != nil {
				if closeCur {
					_ = unix.Close(cur)
				}
				return -1, err
			}
		}
		if closeCur {
			_ = unix.Close(cur)
		}
		cur, closeCur = fd, true
	}
	return cur, nil
}

// openDirChainNoCreate walks existing components without creating any. Fails
// closed if a component is missing or is a symlink/non-directory.
func openDirChainNoCreate(baseFD int, components []string) (int, error) {
	cur := baseFD
	closeCur := false
	for _, comp := range components {
		if comp == "" || comp == "." || comp == ".." {
			if closeCur {
				_ = unix.Close(cur)
			}
			return -1, ErrInvalidPath
		}
		fd, err := openDfd(cur, comp)
		if err != nil {
			if closeCur {
				_ = unix.Close(cur)
			}
			return -1, err
		}
		if closeCur {
			_ = unix.Close(cur)
		}
		cur, closeCur = fd, true
	}
	return cur, nil
}

func openDfd(parent int, comp string) (int, error) {
	return unix.Openat(parent, comp, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}

// sameInode reports whether fd matches the pinned (dev, ino) identity.
func sameInode(fd int, dev, ino uint64) bool {
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil {
		return false
	}
	return uint64(st.Dev) == dev && uint64(st.Ino) == ino
}

// renameAt atomically publishes data from a staging dir into a final dir on
// the same filesystem, refusing to clobber an existing target. The production
// path is the direct platform syscall. A TEST-ONLY seam (attachRenameSeam) may
// replace it; production leaves it nil so the default path is unchanged. Tests
// use it to simulate an UNCERTAIN EIO/ESTALE outcome while performing (or not)
// the real rename, and the seam is opt-in so it cannot affect production.
func renameAt(oldDir int, oldName string, newDir int, newName string) error {
	if attachRenameSeam != nil {
		return attachRenameSeam(oldDir, oldName, newDir, newName)
	}
	return unixRenameNoReplace(oldDir, oldName, newDir, newName)
}

// attachRenameSeam is a test-opt-in seam around renameAt. When non-nil it fully
// owns the rename (it may run the real syscall and still report an injected
// error to simulate an uncertain publish). Never set in production.
var attachRenameSeam func(oldDir int, oldName string, newDir int, newName string) error

func setAttachRenameSeam(fn func(oldDir int, oldName string, newDir int, newName string) error) func() {
	prev := attachRenameSeam
	attachRenameSeam = fn
	return func() { attachRenameSeam = prev }
}

func mapEnoent(err error) error {
	if errors.Is(err, unix.ENOENT) {
		return ErrNotFound
	}
	return err
}

// BeginAttachment creates a fresh staging area and the exclusive controlled
// data file for one upload. serverID must be a server-generated lowercase
// UUID. The staging dir and data file are created with no-follow rooted opens,
// and an owned marker (magic + version + the controlled data name) is written
// so lazy crash cleanup never sweeps arbitrary user files. The root, staging
// dir and data file are pinned by inode; Commit re-verifies every pin before
// hashing and publishing. No bytes are visible at the final path until
// Commit.
func BeginAttachment(root, serverID, mime string, size int64) (*AttachStage, error) {
	if !attachServerID.MatchString(serverID) {
		return nil, ErrInvalidPath
	}
	if size < 0 || size > AttachMaxFileBytes {
		return nil, ErrTooLarge
	}
	canon, err := canonicalRoot(root)
	if err != nil {
		return nil, err
	}
	dataName := AttachmentFilename(mime)
	if dataName == "attachment" || !validSafeLeaf(dataName) {
		return nil, ErrInvalidPath
	}
	rootFD, err := openAttachBase(canon, true)
	if err != nil {
		return nil, mapEnoent(err)
	}
	defer unix.Close(rootFD)
	var rootSt unix.Stat_t
	if unix.Fstat(rootFD, &rootSt) != nil {
		return nil, ErrInvalidPath
	}
	components := append(splitRel(attachStageRel), serverID)
	if attachHook != nil {
		attachHook("pre-stage-mkdir", attachStageRel+"/"+serverID)
	}
	stagingFD, err := ensureDirChain(rootFD, components)
	if err != nil {
		return nil, mapEnoent(err)
	}
	defer unix.Close(stagingFD)
	var stageSt unix.Stat_t
	if unix.Fstat(stagingFD, &stageSt) != nil {
		return nil, ErrInvalidPath
	}
	if attachHook != nil {
		attachHook("pre-data-create", attachStageRel+"/"+serverID+"/"+dataName)
	}
	dataFD, err := unix.Openat(stagingFD, dataName, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, attachFileMode)
	if err != nil {
		if errors.Is(err, unix.EEXIST) {
			return nil, ErrConflict
		}
		return nil, mapEnoent(err)
	}
	if err := writeOwnedMarker(stagingFD, dataName); err != nil {
		_ = unix.Close(dataFD)
		return nil, err
	}
	var dataSt unix.Stat_t
	if unix.Fstat(dataFD, &dataSt) != nil {
		_ = unix.Close(dataFD)
		return nil, ErrInvalidPath
	}
	file := os.NewFile(uintptr(dataFD), dataName)
	return &AttachStage{
		root: canon, serverID: serverID, dataName: dataName,
		finalRel: serverID,
		size:     size, owned: true, file: file,
		rootDev: uint64(rootSt.Dev), rootIno: uint64(rootSt.Ino),
		stageDev: uint64(stageSt.Dev), stageIno: uint64(stageSt.Ino),
		dataDev: uint64(dataSt.Dev), dataIno: uint64(dataSt.Ino),
	}, nil
}

// writeOwnedMarker writes the bounded ownership marker: magic line plus the
// single controlled data name this staging dir owns. Cleanup validates both
// lines before removing anything.
func writeOwnedMarker(stagingFD int, dataName string) error {
	body := attachOwnedMagic + "\n" + dataName + "\n"
	markFD, err := unix.Openat(stagingFD, attachOwnedMark, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, attachFileMode)
	if err != nil {
		if errors.Is(err, unix.EEXIST) {
			return ErrConflict
		}
		return mapEnoent(err)
	}
	defer unix.Close(markFD)
	if _, err := unix.Write(markFD, []byte(body)); err != nil {
		return err
	}
	return unix.Fsync(markFD)
}

// readOwnedMarker bounded-reads the marker at dirFD/uuid/.owned no-follow and
// validates magic/version plus the expected controlled data name.
func readOwnedMarker(sub int) (dataName string, ok bool) {
	var st unix.Stat_t
	if unix.Fstatat(sub, attachOwnedMark, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return "", false
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Size > 128 {
		return "", false
	}
	fd, err := unix.Openat(sub, attachOwnedMark, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", false
	}
	defer unix.Close(fd)
	buf := make([]byte, st.Size+1)
	n, err := unix.Read(fd, buf)
	if err != nil || n > int(st.Size) {
		return "", false
	}
	lines := strings.Split(strings.TrimSpace(string(buf[:n])), "\n")
	if len(lines) != 2 || lines[0] != attachOwnedMagic {
		return "", false
	}
	if !validSafeLeaf(lines[1]) || !dataNameCandidate(lines[1]) {
		return "", false
	}
	return lines[1], true
}

func validSafeLeaf(name string) bool {
	// Controlled basename: ASCII, no slash, no control, cannot be "." / ".." /
	// ".git", cannot start with a dot (hidden traversal/symlink confusion).
	if name == "" || len(name) > 64 || strings.ContainsAny(name, "/\\") {
		return false
	}
	if name == "." || name == ".." || name == ".git" || strings.HasPrefix(name, ".") {
		return false
	}
	for _, r := range name {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

// FinalRel returns the slash-relative committed path once published.
func (st *AttachStage) FinalRel() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.finalRel + "/" + st.dataName
}

// ServerID returns the staging UUID.
func (st *AttachStage) ServerID() string { return st.serverID }

// DataName returns the controlled basename.
func (st *AttachStage) DataName() string { return st.dataName }

// Wrote returns the acknowledged durable byte count.
func (st *AttachStage) Wrote() int64 {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.wrote
}

// Committed reports whether this stage has published — or may have published —
// its data file: the publication barrier. A true result is raised on an actual
// rename AND on an uncertain rename result (EIO/ESTALE) so the daemon can never
// report the upload as cancelled nor release/re-publish it; such a stage must
// be resolved via ReconcileCommitted. It is never raised for a definite
// non-publish (e.g. EEXIST, hash/size mismatch, changed pins).
func (st *AttachStage) Committed() bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.committed
}

// WriteAt places data at exactly offset. It must equal the acknowledged
// offset (sequential, no overwrite/append ambiguity), fit within the declared
// size, and be at most one AttachChunkBytes in length. Successful writes
// advance the acknowledged offset.
func (st *AttachStage) WriteAt(offset int64, data []byte) error {
	return st.writeAtBounded(offset, data, AttachChunkBytes)
}

// WriteAtV2 is identical to WriteAt in every respect except the per-chunk
// limit: a single call may carry up to AttachChunkBytesV2 bytes. Offset,
// inode/FD, state, single-file-write, single file.Sync and durable-offset
// semantics are exactly those of WriteAt (both delegate to
// writeAtBounded); it never fans a large write out into legacy writes.
func (st *AttachStage) WriteAtV2(offset int64, data []byte) error {
	return st.writeAtBounded(offset, data, AttachChunkBytesV2)
}

// writeAtBounded is the shared implementation of WriteAt (maxChunk
// AttachChunkBytes) and WriteAtV2 (maxChunk AttachChunkBytesV2). All
// semantics are identical regardless of the bound: the chunk-size rejection
// happens before locking, the sequential offset / declared-size / state
// checks under the lock, then exactly one file write, exactly one file.Sync,
// and the durable offset advances only after the sync succeeds. A sync
// failure closes the FD and fails the stage closed.
func (st *AttachStage) writeAtBounded(offset int64, data []byte, maxChunk int) error {
	if len(data) > maxChunk {
		return ErrTooLarge
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.closed || st.file == nil {
		return ErrNotFound
	}
	if st.committed {
		return ErrConflict
	}
	if st.wrote != offset {
		return ErrConflict
	}
	if st.wrote+int64(len(data)) > st.size {
		return ErrInvalidRange
	}
	if len(data) == 0 {
		return nil
	}
	n, err := st.file.WriteAt(data, offset)
	if err != nil {
		return err
	}
	if n != len(data) {
		return ErrChanged
	}
	// Acknowledged bytes must be durable: sync before advancing the offset.
	// A sync failure means the receipt would overstate what is on disk, so
	// fail closed and never publish from this stage.
	if err := st.file.Sync(); err != nil {
		_ = st.file.Close()
		st.file = nil
		st.closed = true
		return errors.Join(errors.New("attachment write is not durable"), err)
	}
	st.wrote += int64(len(data))
	return nil
}

// Publish and reconciliation duty (commitPins, Commit, cleanupAfterPublish,
// fsyncPublishChain, verifyPublished, ReconcileCommitted) lives in
// attach_publish_unix.go. This file holds staging life-cycle and I/O.

// Close releases the data-file descriptor without removing anything.
func (st *AttachStage) Close() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.closed {
		return nil
	}
	st.closed = true
	if st.file != nil {
		_ = st.file.Close()
		st.file = nil
	}
	return nil
}

// Abort removes the owned staging artifacts (data file, marker, empty staging
// dir) and closes the descriptor. Committed uploads refuse to abort so a
// finished file is never deleted (the committed winner is reported via
// Commit/ReconcileCommitted, never a cancelled state after publication).
// Unknown files a malicious host appended to a staging dir are left in place
// rather than guessed as ours.
func (st *AttachStage) Abort() error {
	st.mu.Lock()
	if st.committed {
		st.mu.Unlock()
		return ErrConflict
	}
	if st.closed || st.file == nil {
		st.mu.Unlock()
		return ErrNotFound
	}
	if !st.owned {
		st.mu.Unlock()
		return ErrNotFound
	}
	st.closed = true
	file := st.file
	st.file = nil
	st.mu.Unlock()
	if file != nil {
		_ = file.Close()
	}
	rootFD, stagingFD, err := st.commitPins()
	if err != nil {
		return err
	}
	defer unix.Close(rootFD)
	defer unix.Close(stagingFD)
	if name, ok := readOwnedMarker(stagingFD); !ok || name != st.dataName {
		return ErrChanged
	}
	_ = unix.Unlinkat(stagingFD, st.dataName, 0)
	_ = unix.Unlinkat(stagingFD, attachOwnedMark, 0)
	parentFD, err := openDirChainNoCreate(rootFD, splitRel(attachStageRel))
	if err == nil {
		_ = unix.Unlinkat(parentFD, st.serverID, unix.AT_REMOVEDIR)
		_ = unix.Close(parentFD)
	}
	return nil
}
