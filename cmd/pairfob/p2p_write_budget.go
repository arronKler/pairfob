package main

import (
	"context"
	"errors"
	"time"

	"github.com/pion/webrtc/v4"
	"pairfob/internal/mux"
)

func p2pWireBytes(frameBytes int) uint64 {
	return uint64(frameBytes + ((frameBytes+p2pChunkDataBytes-1)/p2pChunkDataBytes)*p2pChunkHeaderBytes)
}

// Keep half the hard cap free for control traffic and post-admission writes.
func (c *webRTCConn) writeReady(frameBytes int) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.channel == nil || c.channel.ReadyState() != webrtc.DataChannelStateOpen {
		return false, errors.New("P2P data channel is not open")
	}
	if frameBytes < 24 || frameBytes > p2pMaxFrameBytes {
		return false, errors.New("invalid P2P frame length")
	}
	need, limit := p2pWireBytes(frameBytes), c.maxBufferedAmount()/2
	if need > limit {
		return false, errors.New("P2P frame exceeds write budget")
	}
	return c.channel.BufferedAmount()+need <= limit, nil
}

func (c *webRTCConn) WriteReady(frameBytes int) bool {
	ready, _ := c.writeReady(frameBytes)
	return ready
}

func (c *webRTCConn) WaitWritable(ctx context.Context, frameBytes int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ready, err := c.writeReady(frameBytes)
	if err != nil || ready {
		return err
	}
	// Polling covers a missed low-water event and peers closing without a drain.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.drained:
		case <-ticker.C:
		}
		ready, err = c.writeReady(frameBytes)
		if err != nil || ready {
			return err
		}
	}
}

var _ mux.WriteBudget = (*webRTCConn)(nil)
