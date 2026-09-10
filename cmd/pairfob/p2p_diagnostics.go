package main

import (
	"context"
	"errors"
	"io"
	"net"
	"time"

	"pairfob/internal/daemon"
)

func transportErrorClass(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "eof"
	}
	if errors.Is(err, net.ErrClosed) {
		return "closed"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "timeout"
	}
	return "other"
}

func (c *webRTCConn) snapshotClose(reason string, err error) daemon.DirectCloseInfo {
	c.mu.Lock()
	channel, peer := c.channel, c.peer
	c.mu.Unlock()
	info := daemon.DirectCloseInfo{Reason: reason, ErrorClass: transportErrorClass(err)}
	if !c.createdAt.IsZero() {
		info.LifetimeMS = time.Since(c.createdAt).Milliseconds()
	}
	if peer != nil {
		info.ICEState = peer.ICEConnectionState().String()
		info.PeerState = peer.ConnectionState().String()
	}
	if channel != nil {
		info.ChannelState = channel.ReadyState().String()
		info.BufferedBytes = channel.BufferedAmount()
	}
	return info
}

// Capture the first observed cause before local cleanup turns every state into
// "closed". Never retain or print raw Pion errors, which can include addresses.
func (c *webRTCConn) noteClose(reason string, err error) {
	info := c.snapshotClose(reason, err)
	c.diagnosticMu.Lock()
	if c.closeInfo.Reason == "" {
		c.closeInfo = info
	}
	c.diagnosticMu.Unlock()
}

func (c *webRTCConn) CloseInfo() daemon.DirectCloseInfo {
	c.diagnosticMu.Lock()
	info := c.closeInfo
	c.diagnosticMu.Unlock()
	if info.Reason == "" {
		return c.snapshotClose("", nil)
	}
	return info
}

func (c *webRTCConn) closeWithReason(reason string, err error) {
	c.noteClose(reason, err)
	c.Close()
}

func (c *webRTCConn) notifyClosedWithReason(reason string, err error) {
	c.noteClose(reason, err)
	c.notifyClosed()
}

// CloseWithReason lets the daemon distinguish protocol rejection from cleanup.
func (c *webRTCConn) CloseWithReason(reason string) {
	c.closeWithReason(reason, nil)
}
