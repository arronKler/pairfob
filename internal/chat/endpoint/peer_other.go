//go:build !linux && !darwin && !freebsd

package endpoint

import (
	"errors"
	"net"
)

// checkPeerUID fails closed on platforms without a peer credential lookup.
func checkPeerUID(*net.UnixConn) error {
	return errors.New("peer credential check is not supported on this platform")
}
