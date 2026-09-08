package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"syscall"
)

// FileRevision binds a directory entry to its inode and nanosecond modification
// time. It is a precondition for mutations, not a digest of the file contents.
func FileRevision(info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() {
		return ""
	}
	return fileRevision(uint64(stat.Dev), uint64(stat.Ino), stat.Size, info.ModTime().Unix(), int64(info.ModTime().Nanosecond()))
}

func fileRevision(device, inode uint64, size, seconds, nanos int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%d:%d:%d", device, inode, size, seconds, nanos)))
	return hex.EncodeToString(sum[:])
}
