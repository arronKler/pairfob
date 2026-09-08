package admin

import (
	"errors"
	"golang.org/x/sys/unix"
	"net"
)

func peerCredentials(conn *net.UnixConn) (int, uint32, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *unix.Ucred
	var inner error
	err = raw.Control(func(fd uintptr) { cred, inner = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
	if err != nil {
		return 0, 0, err
	}
	if inner != nil {
		return 0, 0, inner
	}
	return int(cred.Pid), cred.Uid, nil
}

func isRefused(err error) bool { return errors.Is(err, unix.ECONNREFUSED) }
