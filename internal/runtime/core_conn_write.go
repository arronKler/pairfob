package runtime

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"time"
)

// Frame writes for herdr-core. Every frame passes through one writer
// goroutine, so frames reach the pipe in the order they were queued and a
// frame that gave up waiting is never written after a later one. The core's
// stdin is an os/exec pipe, which cannot carry a write deadline; a core that
// stopped reading would otherwise wedge Call (and, with it, the whole
// runtime), so each write is bounded and expiry shuts the connection down.
const (
	// coreWriteTimeout bounds one frame's wait in the queue plus its write.
	coreWriteTimeout = 2 * time.Second
	// coreWriteQueue is how many frames may wait behind the frame being
	// written. Input frames are tiny; the bound makes a stuck writer fail
	// instead of buffering without limit.
	coreWriteQueue = 32
)

var errCoreWriteClosed = errors.New("terminal core connection closed")

type coreWriteRequest struct {
	frame []byte
	done  chan error
}

// writeLoop is the connection's only framed writer. It stops at the first
// failed write because the pipe may then hold a partial frame.
func (c *coreConn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case request := <-c.writeCh:
			select {
			case <-c.done:
				request.done <- errCoreWriteClosed
				continue
			default:
			}
			written, err := c.rw.Write(request.frame)
			if err == nil && written != len(request.frame) {
				err = io.ErrShortWrite
			}
			request.done <- err
			if err != nil {
				c.shutdown(c.transportErr(err))
				return
			}
		}
	}
}

// writeFrame queues one frame and waits for writeLoop. ctx and the
// connection's write timeout both end the wait. Expiry shuts the connection
// down, because a frame that timed out may already be half on the pipe and a
// later frame must not be appended to it.
func (c *coreConn) writeFrame(ctx context.Context, channel uint32, kind byte, payload []byte) error {
	frame := make([]byte, coreFrameHeader+len(payload))
	binary.LittleEndian.PutUint32(frame[0:4], channel)
	frame[4] = kind
	binary.LittleEndian.PutUint32(frame[5:9], uint32(len(payload)))
	copy(frame[coreFrameHeader:], payload)
	request := coreWriteRequest{frame: frame, done: make(chan error, 1)}
	writeCtx, cancel := context.WithTimeout(ctx, c.writeTimeout)
	defer cancel()
	select {
	case c.writeCh <- request:
	case <-writeCtx.Done():
		c.shutdown(&coreTransportError{cause: writeCtx.Err(), timeout: true})
		return writeCtx.Err()
	case <-c.done:
		return errCoreWriteClosed
	}
	select {
	case err := <-request.done:
		return err
	case <-writeCtx.Done():
		c.shutdown(&coreTransportError{cause: writeCtx.Err(), timeout: true})
		return writeCtx.Err()
	case <-c.done:
		return errCoreWriteClosed
	}
}
