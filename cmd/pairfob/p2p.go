package main

import (
	"context"
	"errors"
	"sync"

	"github.com/pion/webrtc/v4"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

const (
	p2pDataChannelLabel    = "pairfob"
	p2pDataChannelProtocol = "pairfob.v1"
	p2pMaxBufferedBytes    = 2 * 1024 * 1024
)

type webRTCAcceptor struct {
	configuration webrtc.Configuration
}

func newWebRTCAcceptor() *webRTCAcceptor {
	return &webRTCAcceptor{configuration: webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}},
	}}
}

func (a *webRTCAcceptor) Accept(
	ctx context.Context,
	offer string,
	onFrame func(mux.Conn, envelope.Frame),
	onClose func(mux.Conn),
) (string, mux.Conn, error) {
	peer, err := webrtc.NewPeerConnection(a.configuration)
	if err != nil {
		return "", nil, err
	}
	link := &webRTCConn{peer: peer, onFrame: onFrame, onClose: onClose}
	peer.OnDataChannel(func(channel *webrtc.DataChannel) {
		if channel.Label() != p2pDataChannelLabel || channel.Protocol() != p2pDataChannelProtocol ||
			!channel.Ordered() || channel.MaxPacketLifeTime() != nil || channel.MaxRetransmits() != nil ||
			channel.Negotiated() || !link.attach(channel) {
			_ = channel.Close()
			return
		}
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			encoded, assembleErr := link.assembler.Push(message.Data)
			if assembleErr != nil {
				link.Close()
				return
			}
			if encoded == nil {
				return
			}
			frame, decodeErr := envelope.Decode(encoded)
			if decodeErr != nil {
				link.Close()
				return
			}
			onFrame(link, frame)
		})
		channel.OnClose(link.notifyClosed)
		channel.OnError(func(error) { link.notifyClosed() })
	})
	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			link.notifyClosed()
		}
	})
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		link.Close()
		return "", nil, err
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		link.Close()
		return "", nil, err
	}
	gathered := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(answer); err != nil {
		link.Close()
		return "", nil, err
	}
	select {
	case <-ctx.Done():
		link.Close()
		return "", nil, ctx.Err()
	case <-gathered:
	}
	local := peer.LocalDescription()
	if local == nil || local.SDP == "" {
		link.Close()
		return "", nil, errors.New("WebRTC answer missing local description")
	}
	return local.SDP, link, nil
}

type webRTCConn struct {
	peer      *webrtc.PeerConnection
	onFrame   func(mux.Conn, envelope.Frame)
	onClose   func(mux.Conn)
	mu        sync.Mutex
	channel   *webrtc.DataChannel
	closed    bool
	closeOnce sync.Once
	assembler p2pFrameAssembler
}

func (c *webRTCConn) attach(channel *webrtc.DataChannel) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.channel != nil {
		return false
	}
	c.channel = channel
	return true
}

func (c *webRTCConn) Send(frame envelope.Frame) error {
	encoded, err := envelope.EncodeChecked(frame)
	if err != nil {
		return err
	}
	chunks, err := splitP2PFrame(encoded)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.closed || c.channel == nil || c.channel.ReadyState() != webrtc.DataChannelStateOpen {
		c.mu.Unlock()
		return errors.New("P2P data channel is not open")
	}
	bufferedBytes := uint64(0)
	for _, chunk := range chunks {
		bufferedBytes += uint64(len(chunk))
	}
	if c.channel.BufferedAmount()+bufferedBytes > p2pMaxBufferedBytes {
		c.mu.Unlock()
		return errors.New("P2P send queue is full")
	}
	for _, chunk := range chunks {
		if err := c.channel.Send(chunk); err != nil {
			c.mu.Unlock()
			c.Close()
			return err
		}
	}
	c.mu.Unlock()
	return nil
}

func (c *webRTCConn) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	channel := c.channel
	c.mu.Unlock()
	if channel != nil {
		_ = channel.Close()
	}
	_ = c.peer.Close()
	c.notifyClosed()
}

func (c *webRTCConn) notifyClosed() {
	c.closeOnce.Do(func() { c.onClose(c) })
}
