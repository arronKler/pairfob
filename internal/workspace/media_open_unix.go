//go:build unix

package workspace

import "golang.org/x/sys/unix"

func openNoFollowNonblock() int {
	return unix.O_NOFOLLOW | unix.O_NONBLOCK
}
