//go:build linux

package endpoint

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// checkPeerUID refuses a connection from another user.
func checkPeerUID(conn *net.UnixConn) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var (
		cred *unix.Ucred
		fail error
	)
	if err := raw.Control(func(fd uintptr) {
		cred, fail = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if fail != nil {
		return fail
	}
	if int(cred.Uid) != os.Getuid() {
		return fmt.Errorf("peer uid %d does not match process uid %d", cred.Uid, os.Getuid())
	}
	return nil
}
