package runtime

import (
	"context"
	"encoding/binary"
	"sync"
)

// The core starts streams with 256 KiB of DATA credit. Keep a bounded queue
// larger than that window, including frame overhead, and return credit only
// when the consumer receives an item. Slow viewers pause their own stream
// without blocking the shared RPC reader. Resize frames retain DATA ordering.
const coreStreamQueueBytes = 4 << 20

func coreStreamItemBytes(item coreStreamItem) int { return coreFrameHeader + len(item.payload) }

type coreStreamSink struct {
	mu       sync.Mutex
	items    chan coreStreamItem
	queue    []coreStreamItem
	bytes    int
	closed   bool
	wake     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	credit   func(int)
}

func newCoreStreamSink(credit func(int)) *coreStreamSink {
	s := &coreStreamSink{items: make(chan coreStreamItem), wake: make(chan struct{}, 1), stop: make(chan struct{}), credit: credit}
	go s.run()
	return s
}

func (s *coreStreamSink) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// deliver never waits for a consumer or a CREDIT write on the shared reader.
func (s *coreStreamSink) deliver(item coreStreamItem) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return true
	}
	size := coreStreamItemBytes(item)
	if s.bytes+size > coreStreamQueueBytes {
		return false
	}
	s.queue = append(s.queue, item)
	s.bytes += size
	s.signal()
	return true
}

func (s *coreStreamSink) run() {
	defer close(s.items)
	for {
		s.mu.Lock()
		if len(s.queue) == 0 {
			closed := s.closed
			s.mu.Unlock()
			if closed {
				return
			}
			select {
			case <-s.wake:
				continue
			case <-s.stop:
				return
			}
		}
		item := s.queue[0]
		s.queue[0] = coreStreamItem{}
		s.queue = s.queue[1:]
		s.bytes -= coreStreamItemBytes(item)
		s.mu.Unlock()
		select {
		case s.items <- item:
		case <-s.stop:
			return
		}
		if item.kind == coreKindData && s.credit != nil {
			s.credit(len(item.payload))
		}
	}
}

// A remote CLOSE drains accepted frames before the consumer sees EOF.
func (s *coreStreamSink) close() {
	s.mu.Lock()
	s.closed = true
	s.signal()
	s.mu.Unlock()
}

// Detach and connection shutdown also release a worker blocked on its reader.
func (s *coreStreamSink) abort() {
	s.mu.Lock()
	s.closed = true
	s.queue = nil
	s.bytes = 0
	s.stopOnce.Do(func() { close(s.stop) })
	s.mu.Unlock()
}

type coreStream struct {
	sink  *coreStreamSink
	ended bool
}

// The pending replay is installed under streamsMu so live frames cannot
// overtake frames read before the attach response reached its caller.
func (c *coreConn) watchStream(channel uint32) <-chan coreStreamItem {
	sink := newCoreStreamSink(func(size int) { c.creditStream(channel, size) })
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.sink = sink
	buffered, ended := c.takePending(channel), stream.ended || c.streamsClosed
	overflowed := false
	for _, item := range buffered {
		if !sink.deliver(item) {
			overflowed = true
			break
		}
	}
	if ended {
		sink.close()
	}
	if c.streamsClosed {
		sink.abort()
	}
	c.streamsMu.Unlock()
	if overflowed {
		c.endStream(channel)
	}
	return sink.items
}

func (c *coreConn) discardStream(channel uint32) {
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.sink = nil
	buffered := c.takePending(channel)
	c.streamsMu.Unlock()
	consumed := 0
	for _, item := range buffered {
		if item.kind == coreKindData {
			consumed += len(item.payload)
		}
	}
	c.creditStream(channel, consumed)
}

func (c *coreConn) takePending(channel uint32) []coreStreamItem {
	buffered := c.pendingIn[channel]
	delete(c.pendingIn, channel)
	for _, item := range buffered {
		c.pendingBytes -= coreStreamItemBytes(item)
	}
	return buffered
}

func (c *coreConn) endStream(channel uint32) *coreStreamSink {
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.ended = true
	sink := stream.sink
	// CLOSE can beat watchStream: retain the uncredited replay until the
	// caller watches it, or explicitly discards/detaches it.
	if sink != nil {
		c.takePending(channel)
	}
	c.streamsMu.Unlock()
	if sink != nil {
		sink.close()
	}
	return sink
}

func (c *coreConn) streamEnded(channel uint32) bool {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	stream := c.streams[channel]
	return stream != nil && stream.ended
}

func (c *coreConn) routeStream(channel uint32, item coreStreamItem) {
	c.streamsMu.Lock()
	if c.streamsClosed {
		c.streamsMu.Unlock()
		return
	}
	stream := c.streams[channel]
	if stream == nil {
		size := coreStreamItemBytes(item)
		if c.pendingBytes+size <= corePendingStreamBytes {
			c.pendingIn[channel] = append(c.pendingIn[channel], item)
			c.pendingBytes += size
		} else {
			c.takePending(channel)
			c.streams[channel] = &coreStream{ended: true}
		}
		c.streamsMu.Unlock()
		return
	}
	if stream.ended {
		c.streamsMu.Unlock()
		return
	}
	sink := stream.sink
	c.streamsMu.Unlock()
	if sink == nil {
		if item.kind == coreKindData {
			c.creditStream(channel, len(item.payload))
		}
	} else if !sink.deliver(item) {
		c.endStream(channel)
	}
}

func (c *coreConn) creditStream(channel uint32, size int) {
	if size == 0 {
		return
	}
	consumed := make([]byte, 4)
	binary.LittleEndian.PutUint32(consumed, uint32(size))
	if err := c.writeFrame(context.Background(), channel, coreKindCredit, consumed); err != nil {
		c.shutdown(c.transportErr(err))
	}
}
