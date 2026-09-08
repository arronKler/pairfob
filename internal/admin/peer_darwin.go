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
	var pid int
	var uid uint32
	var inner error
	err = raw.Control(func(fd uintptr) {
		pid, inner = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		if inner != nil {
			return
		}
		var cred *unix.Xucred
		cred, inner = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if inner == nil {
			uid = cred.Uid
		}
	})
	if err != nil {
		return 0, 0, err
	}
	return pid, uid, inner
}

func isRefused(err error) bool { return errors.Is(err, unix.ECONNREFUSED) }
