//go:build unix

// Publish and reconciliation duty for a staged attachment: Commit atomically
// publishes the verified inode into the final UUID directory (quota + rename
// serialized, full created-directory chain fsynced), and ReconcileCommitted
// verifies a prior publish's durability without republishing. Split from
// attach_unix.go so no handwritten file exceeds the 800-line duty budget.
package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// commitPins re-verifies, by pinned inode identity, the root, the staging
// dir and the staged data file. Any replacement or symlink swap of these
// fails closed with ErrChanged before hashing or publishing.
func (st *AttachStage) commitPins() (rootFD, stagingFD int, err error) {
	canon, err := canonicalRoot(st.root)
	if err != nil {
		return -1, -1, err
	}
	if canon != st.root {
		return -1, -1, ErrChanged
	}
	rootFD, err = openAttachBase(canon, false)
	if err != nil {
		return -1, -1, mapEnoent(err)
	}
	if !sameInode(rootFD, st.rootDev, st.rootIno) {
		unix.Close(rootFD)
		return -1, -1, ErrChanged
	}
	stagingFD, err = openDirChainNoCreate(rootFD, append(splitRel(attachStageRel), st.serverID))
	if err != nil {
		unix.Close(rootFD)
		return -1, -1, mapEnoent(err)
	}
	if !sameInode(stagingFD, st.stageDev, st.stageIno) {
		unix.Close(stagingFD)
		unix.Close(rootFD)
		return -1, -1, ErrChanged
	}
	return rootFD, stagingFD, nil
}

// Commit verifies the full staged length and SHA-256 match the declared file,
// revalidates every pinned identity (root, staging dir, staged data inode),
// then atomically publishes the exact hashed inode under the final UUID
// directory. The data file descriptor hashed is the descriptor renamed: no
// pathname is reopened between hash and publish, so a path replacement cannot
// publish different bytes than were verified.
//
// The completed-storage quota is enforced inside the same serialized section
// as the publish (process-wide), so concurrent commits cannot together exceed
// AttachCompletedPerRoot; Begin's check stays advisory. After a successful
// rename, any failure (e.g. directory fsync) returns ErrMutationUnknown with
// Published=true: the committed result exists, and the caller reconciles via
// read-only status rather than attempting a second blind publish.
func (st *AttachStage) Commit(declaredSize int64, sha256hex string) (AttachCommitResult, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	rel := st.finalRel + "/" + st.dataName
	if st.committed {
		// A prior attempt already renamed the data file (even if its result
		// was reported as unknown): delegate to the non-publishing
		// reconciliation path so the daemon gets the verified current state;
		// never re-publish.
		st.mu.Unlock()
		res, rerr := st.ReconcileCommitted()
		st.mu.Lock()
		if rerr == nil {
			return res, ErrConflict
		}
		// Reconciliation itself uncertain: surface the reconcilable committed
		// result with the conflict semantics preserved.
		return res, ErrConflict
	}
	if st.closed || st.file == nil {
		return AttachCommitResult{Rel: rel}, ErrNotFound
	}
	if !st.owned {
		return AttachCommitResult{Rel: rel}, ErrNotFound
	}
	if declaredSize != st.size || st.wrote != declaredSize {
		return AttachCommitResult{Rel: rel}, ErrConflict
	}
	// The data inode is verified through the OPEN DESCRIPTOR (never by
	// reopening the pathname), so the bytes hashed are the bytes published.
	var dataSt unix.Stat_t
	if unix.Fstat(int(st.file.Fd()), &dataSt) != nil {
		return AttachCommitResult{Rel: rel}, ErrInvalidPath
	}
	if uint64(dataSt.Dev) != st.dataDev || uint64(dataSt.Ino) != st.dataIno {
		return AttachCommitResult{Rel: rel}, ErrChanged
	}
	cur, err := st.file.Stat()
	if err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	if cur.Size() != declaredSize {
		return AttachCommitResult{Rel: rel}, ErrConflict
	}
	if _, err := st.file.Seek(0, io.SeekStart); err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, st.file); err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	if hex.EncodeToString(sum.Sum(nil)) != strings.ToLower(sha256hex) {
		return AttachCommitResult{Rel: rel}, ErrChanged
	}
	if _, err := st.file.Seek(0, io.SeekEnd); err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	// Durability: the data file's bytes and length must be on disk before it
	// is atomically exposed at the final path.
	if err := st.file.Sync(); err != nil {
		return AttachCommitResult{Rel: rel}, err
	}

	// Serialize quota check + publish across the whole process so concurrent
	// commits cannot each pass a quota check and overshoot together.
	attachQuotaMu.Lock()
	defer attachQuotaMu.Unlock()

	rootFD, stagingFD, err := st.commitPins()
	if err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	defer unix.Close(rootFD)
	defer unix.Close(stagingFD)
	// The pinned staging dir must still carry a marker naming EXACTLY our
	// controlled data file (not merely any well-formed marker) before
	// anything is moved or removed.
	if name, ok := readOwnedMarker(stagingFD); !ok || name != st.dataName {
		return AttachCommitResult{Rel: rel}, ErrChanged
	}
	// Fail-closed completed-storage quota: any scan error aborts the publish.
	used, err := AttachCompletedBytes(st.root)
	if err != nil {
		return AttachCommitResult{Rel: rel}, err
	}
	if used+declaredSize > attachCompletedLimit {
		return AttachCommitResult{Rel: rel}, ErrTooLarge
	}
	finalFD, err := ensureDirChain(rootFD, []string{st.serverID})
	if err != nil {
		return AttachCommitResult{Rel: rel}, mapEnoent(err)
	}
	defer unix.Close(finalFD)
	var finalDirSt unix.Stat_t
	if unix.Fstat(finalFD, &finalDirSt) != nil {
		return AttachCommitResult{Rel: rel}, ErrInvalidPath
	}
	// Save the reconciliation metadata (pinned data inode, verified digest,
	// size, final dir inode) BEFORE attempting the rename so an UNCERTAIN
	// syscall result (EIO/ESTALE) still records the pins needed to reconcile a
	// publish that may or may not have taken effect. They are terminal for
	// this stage instance. The publication barrier (st.committed) is raised
	// only on EIO/ESTALE or an actual rename, never on a definite non-publish.
	st.finalSum = strings.ToLower(sha256hex)
	st.finalSize = declaredSize
	st.finalDev, st.finalIno = st.dataDev, st.dataIno
	st.finalDirDev, st.finalDirIno = uint64(finalDirSt.Dev), uint64(finalDirSt.Ino)

	if attachHook != nil {
		attachHook("pre-rename", attachStageRel+"/"+st.serverID+"/"+st.dataName)
	}
	// Re-verify the staged directory entry still resolves to the hashed
	// inode immediately before the rename: a name swap (replacement file or
	// symlink) inside the pinned staging dir must fail closed instead of
	// publishing unverified bytes.
	var preSt unix.Stat_t
	if unix.Fstatat(stagingFD, st.dataName, &preSt, unix.AT_SYMLINK_NOFOLLOW) != nil ||
		preSt.Mode&unix.S_IFMT != unix.S_IFREG ||
		uint64(preSt.Dev) != st.dataDev || uint64(preSt.Ino) != st.dataIno {
		return AttachCommitResult{Rel: rel}, ErrChanged
	}
	if err := renameAt(stagingFD, st.dataName, finalFD, st.dataName); err != nil {
		if errors.Is(err, unix.EEXIST) {
			// Definite non-publish: nothing happened, no publication barrier,
			// stage stays cancellable and reconciliation stays a conflict.
			return AttachCommitResult{Rel: rel}, ErrConflict
		}
		if errors.Is(err, unix.EIO) || errors.Is(err, unix.ESTALE) {
			// UNCERTAIN: the rename may or may not have taken effect. Raise the
			// publication barrier so the daemon can never report this upload as
			// cancelled (Committed() is true) and never blind-publish a second
			// renamed file. ReconcileCommitted verifies the final inode if one
			// is present and never calls rename again; if no final entry is
			// found it stays unknown until expiry/reconciliation. Never fabricate
			// success, never delete a foreign final entry.
			st.committed = true
			st.published = false
			return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
		}
		return AttachCommitResult{Rel: rel}, mapEnoent(err)
	}
	// The rename happened: an effect now exists. Raise the publication barrier
	// (metadata was already saved above) BEFORE any post-rename step can fail, so
	// a retry conflicts and ReconcileCommitted can verify even after st.file is
	// closed; never blind-publish.
	st.committed = true
	// Post-rename verification: the final entry must currently resolve, via
	// no-follow rooted dirfds, to the pinned hashed inode and declared size.
	// A replacement or symlink swap of the final entry is NOT a verified
	// publish: report unknown outcome with Published=false (an effect
	// occurred; the current entry is not ours) and never delete the foreign
	// replacement. This does not promise protection against an arbitrary
	// malicious host moving the whole root; it detects the hook-window cases.
	if attachHook != nil {
		attachHook("post-rename-verify", rel)
	}
	verify, verr := st.verifyPublished(rootFD, finalFD)
	if verr != nil || !verify {
		st.published = false
		return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
	}
	st.published = true
	// Durability of the newly-created final path: fsync the final dir AND
	// its parent attachments dir (the chain root→attachments→<uuid> may have
	// just been created; each new dir entry needs its parent's fsync to
	// survive a crash). The data file itself was fsynced before the rename.
	fsyncErr := fsyncPublishChain(rootFD, finalFD)
	if fsyncErr == nil && attachErrHook != nil {
		fsyncErr = attachErrHook("post-rename-fsync")
	}
	if fsyncErr != nil {
		return AttachCommitResult{Rel: rel, Published: true}, ErrMutationUnknown
	}
	// Best-effort staging cleanup after a confirmed publish: remove this
	// stage's own marker and per-UUID staging dir and close the retained
	// data descriptor. The shared .staging base is never deleted (other
	// concurrent stages may still use it), and completed files are never
	// touched; the committed file is already durable either way.
	st.cleanupAfterPublish(rootFD)
	return AttachCommitResult{Rel: rel, Published: true}, nil
}

// cleanupAfterPublish removes this stage's OWN staging leftovers after a
// confirmed durable publish: the staging ownership marker, the (now-empty)
// per-UUID staging directory, and closes the retained data-file descriptor
// (the data itself was renamed into the final dir long ago). It never touches
// completed files and never deletes the shared .staging parent (other
// concurrent stages may still use it). Removal is gated on re-verifying the
// pinned staging dir inode and an exact owned-marker naming OUR controlled
// data file, so a swapped directory is never swept. Caller must hold st.mu
// and pass the pinned rootFD; staging pins are re-opened and re-verified here
// so it is safe to call after any publish path. No syscall is issued through
// the closed data descriptor.
func (st *AttachStage) cleanupAfterPublish(rootFD int) {
	if st.file != nil {
		_ = st.file.Close()
		st.file = nil
	}
	st.closed = true
	stagingFD, err := openDirChainNoCreate(rootFD, append(splitRel(attachStageRel), st.serverID))
	if err != nil {
		st.durable = true
		return
	}
	defer unix.Close(stagingFD)
	// Re-verify the staging dir inode pin before removing anything.
	if !sameInode(stagingFD, st.stageDev, st.stageIno) {
		st.durable = true
		return
	}
	if name, ok := readOwnedMarker(stagingFD); !ok || name != st.dataName {
		st.durable = true
		return
	}
	_ = unix.Unlinkat(stagingFD, attachOwnedMark, 0)
	if parentFD, perr := openDirChainNoCreate(rootFD, splitRel(attachStageRel)); perr == nil {
		_ = unix.Unlinkat(parentFD, st.serverID, unix.AT_REMOVEDIR)
		_ = unix.Close(parentFD)
	}
	st.durable = true
}

// fsyncPublishChain makes a just-published final path durable: fsync the
// final directory (the rename entry) and the base directory that holds the
// new <uuid> entry. Any error is returned so the caller reports the publish as
// uncertain (ErrMutationUnknown) and lets reconciliation retry the same
// fsyncs. Called with rootFD open on the pinned base directory.
func fsyncPublishChain(rootFD, finalFD int) error {
	if err := unix.Fsync(finalFD); err != nil {
		return err
	}
	// Test seam: inject a failure at the final root fsync (F1.1) so the error
	// is exercised as published-unknown then reconciled.
	if attachErrHook != nil {
		if err := attachErrHook("pre-root-fsync"); err != nil {
			return err
		}
	}
	// The uuid entry lives in the base directory: fsync it so the fresh
	// chain is durable. Propagated as published-unknown on failure.
	return unix.Fsync(rootFD)
}

// verifyPublished checks that the final entry currently resolves, via
// no-follow opens under the pinned root, to the pinned hashed inode with the
// declared size, and (when the digest is known) matching content hash. It
// never writes, renames or deletes anything. Returns whether the final entry
// is the verified published inode.
func (st *AttachStage) verifyPublished(rootFD, finalFD int) (bool, error) {
	var entry unix.Stat_t
	if err := unix.Fstatat(finalFD, st.dataName, &entry, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			// The published entry is gone (moved/unlinked): an effect occurred
			// but the current state is not a verified publish; unknown, never a
			// plain not-found that could be read as "nothing happened".
			return false, nil
		}
		return false, mapEnoent(err)
	}
	if entry.Mode&unix.S_IFMT != unix.S_IFREG {
		return false, nil
	}
	if uint64(entry.Dev) != st.finalDev || uint64(entry.Ino) != st.finalIno || entry.Size != st.finalSize {
		return false, nil
	}
	// Confirm the final directory itself is still the one we published into
	// (no dir swap after the rename).
	if !sameInode(finalFD, st.finalDirDev, st.finalDirIno) {
		return false, nil
	}
	// Root pin still holds.
	if !sameInode(rootFD, st.rootDev, st.rootIno) {
		return false, nil
	}
	// Digest check: reopen the final file BY INODE (openat no-follow under
	// the pinned final dir; the entry was just verified to be our inode) and
	// re-hash it so "verified" means the bytes, not just the identity.
	fd, err := unix.Openat(finalFD, st.dataName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, mapEnoent(err)
	}
	// The *os.File is the single owner of the raw fd from here on. Do NOT
	// also unix.Close the raw fd: os.NewFile arms a finalizer that closes the
	// descriptor if the wrapper is never closed, so a second raw close here
	// could let that finalizer later close a REUSED descriptor number
	// belonging to a different upload/socket. Close exactly once via the
	// wrapper. If the wrapper cannot be created, close the raw fd directly.
	file := os.NewFile(uintptr(fd), st.dataName)
	if file == nil {
		_ = unix.Close(fd)
		return false, nil
	}
	defer file.Close()
	// The entry could change between Fstatat and Openat; re-verify the open
	// descriptor is the pinned inode before trusting its bytes.
	var openSt unix.Stat_t
	if unix.Fstat(int(file.Fd()), &openSt) != nil || uint64(openSt.Dev) != st.finalDev || uint64(openSt.Ino) != st.finalIno {
		return false, nil
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return false, err
	}
	return hex.EncodeToString(sum.Sum(nil)) == st.finalSum, nil
}

// ReconcileCommitted verifies, without publishing anything, whether a prior
// Commit's effect is durably present at the final path. It must be used
// after a Commit returned ErrMutationUnknown (or any uncertain outcome) and
// also works after a successful Commit closed the data-file descriptor: the
// pinned inode, verified digest and declared size saved at rename time are
// checked against the CURRENT final entry via no-follow dirfd opens.
//
// Results:
//   - (AttachCommitResult{Rel, Published: true}, nil): the final entry IS the
//     hashed inode with matching digest and size, and the directory chain
//     fsync succeeded — the commit is durably reconciled.
//   - (AttachCommitResult{Rel, Published: true}, ErrMutationUnknown): the
//     final entry matches but the durability fsync retry failed; output
//     files are preserved and the caller may retry reconciliation later.
//   - (AttachCommitResult{Rel, Published: false}, ErrMutationUnknown): the
//     final entry does not match the pinned inode/digest/size (or the pinned
//     root/dir chain changed): an effect occurred but the current entry is
//     not ours; never delete a foreign replacement, reconcile via status.
//   - (…, ErrConflict/ErrNotFound): the stage never published (no rename
//     happened), so there is nothing to reconcile.
//
// Once a durable result is confirmed it is cached on the stage: subsequent
// calls short-circuit to the same terminal result without re-hashing the
// whole file, because the rename-time pins are terminal for this stage
// instance and re-verifying every Status would be wasteful. This cache does
// NOT mean the bytes remain immutable on disk — a sufficiently privileged
// external host can still swap the final file between processes; that
// guarantee is out of scope (a full re-open/re-hash would be required to
// detect it, and commit does not claim to protect against an arbitrary
// malicious host).
//
// It NEVER renames, writes, publishes or deletes completed files; the only
// mutations it may perform are retrying the durability fsync of already
// present directories and cleaning up this stage's own staging leftovers once
// the publish is confirmed durable.
func (st *AttachStage) ReconcileCommitted() (AttachCommitResult, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	rel := st.finalRel + "/" + st.dataName
	if !st.committed {
		return AttachCommitResult{Rel: rel}, ErrConflict
	}
	// A prior publish already verified durable: idempotent success (cached
	// terminal result; see the method comment).
	if st.durable {
		return AttachCommitResult{Rel: rel, Published: st.published}, nil
	}
	cannon, err := canonicalRoot(st.root)
	if err != nil {
		return AttachCommitResult{Rel: rel, Published: st.published}, err
	}
	if cannon != st.root {
		return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
	}
	rootFD, err := openAttachBase(st.root, false)
	if err != nil {
		return AttachCommitResult{Rel: rel, Published: st.published}, mapEnoent(err)
	}
	defer unix.Close(rootFD)
	if !sameInode(rootFD, st.rootDev, st.rootIno) {
		return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
	}
	finalFD, err := openDirChainNoCreate(rootFD, []string{st.serverID})
	if err != nil {
		// Final dir missing: the publish did not durably land (or was moved).
		return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
	}
	defer unix.Close(finalFD)
	verify, verr := st.verifyPublished(rootFD, finalFD)
	if verr != nil {
		return AttachCommitResult{Rel: rel, Published: st.published}, verr
	}
	if !verify {
		st.published = false
		return AttachCommitResult{Rel: rel, Published: false}, ErrMutationUnknown
	}
	// The final entry is verified ours; only the durability fsync is retried
	// (never rename/write/publish). Preserve output files on any failure.
	st.published = true
	fsyncErr := fsyncPublishChain(rootFD, finalFD)
	if fsyncErr == nil && attachErrHook != nil {
		fsyncErr = attachErrHook("post-rename-fsync")
	}
	if fsyncErr != nil {
		return AttachCommitResult{Rel: rel, Published: true}, ErrMutationUnknown
	}
	// Reconciliation is now confirmed durable: perform the same safe
	// own-marker/own-UUID cleanup as Commit (never completed files, never the
	// shared .staging base) and close the retained data descriptor. No syscall
	// is issued through the stale descriptor after this.
	st.cleanupAfterPublish(rootFD)
	return AttachCommitResult{Rel: rel, Published: true}, nil
}
