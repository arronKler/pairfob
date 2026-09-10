package phone

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

type rpcOutcome struct {
	raw json.RawMessage
	err error
}

func (c *Client) newRequestID() (string, error) {
	var idb [8]byte
	if _, err := io.ReadFull(rand.Reader, idb[:]); err != nil {
		return "", err
	}
	return "req_" + hex.EncodeToString(idb[:]), nil
}

func (c *Client) sendRPC(op string, params any) (string, error) {
	id, err := c.newRequestID()
	if err != nil {
		return "", err
	}
	return id, c.sendRPCID(id, op, params)
}

func (c *Client) sendRPCID(id, op string, params any) error {
	if !c.Established || c.c2s == nil || c.s2c == nil {
		return errors.New("session not established")
	}
	body := sessionkeys.MustJSON(map[string]any{"v": 1, "id": id, "op": op, "params": params})
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	payload, err := aead.Seal(c.c2s, c.routeID, body)
	if err != nil {
		return err
	}
	return c.Conn.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: c.routeID, Payload: payload})
}

func (c *Client) StartRPCMux() {
	c.muxOnce.Do(func() {
		c.muxMu.Lock()
		c.muxPending = map[string]chan rpcOutcome{}
		c.muxMu.Unlock()
		go c.muxLoop()
	})
}

func (c *Client) MuxRPC(op string, params any, timeout time.Duration) (json.RawMessage, error) {
	c.StartRPCMux()
	id, err := c.newRequestID()
	if err != nil {
		return nil, err
	}
	wait := make(chan rpcOutcome, 1)
	c.muxMu.Lock()
	c.muxPending[id] = wait
	c.muxMu.Unlock()
	if err := c.sendRPCID(id, op, params); err != nil {
		c.muxMu.Lock()
		delete(c.muxPending, id)
		c.muxMu.Unlock()
		return nil, err
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case out := <-wait:
		return out.raw, out.err
	case <-timer.C:
		c.muxMu.Lock()
		delete(c.muxPending, id)
		c.muxMu.Unlock()
		return nil, errors.New("timeout")
	}
}

func (c *Client) muxLoop() {
	p, ok := c.Conn.(*mux.Pipe)
	if !ok {
		c.failMux(errors.New("mux requires a pipe conn"))
		return
	}
	for {
		f, ok := p.Recv()
		if !ok {
			c.failMux(errors.New("disconnected"))
			return
		}
		c.dispatchMux(f)
	}
}

func (c *Client) dispatchMux(f envelope.Frame) {
	if f.Typ == envelope.TypERROR {
		c.failMux(frameError(f))
		return
	}
	if f.Typ != envelope.TypFWD || f.RouteID != c.routeID {
		c.failMux(fmt.Errorf("unexpected RPC frame type=%#x route=%x", f.Typ, f.RouteID))
		return
	}
	pt, err := aead.Open(c.s2c, c.routeID, f.Payload)
	if err != nil {
		c.failMux(err)
		return
	}
	var peek struct {
		ID string `json:"id"`
		Op string `json:"op"`
	}
	if err := json.Unmarshal(pt, &peek); err != nil {
		c.failMux(errors.New("invalid RPC response"))
		return
	}
	if peek.ID == "" && (peek.Op == "TerminalFrame" || peek.Op == "TerminalClosed") {
		c.Events = append(c.Events, append(json.RawMessage(nil), pt...))
		return
	}
	var resp struct {
		ID     string          `json:"id"`
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(pt, &resp); err != nil || resp.ID == "" {
		c.failMux(errors.New("invalid RPC response"))
		return
	}
	out := rpcOutcome{raw: resp.Result}
	if !resp.OK {
		if resp.Error != nil {
			out.err = errors.New(resp.Error.Code)
		} else {
			out.err = errors.New("rpc failed")
		}
	}
	c.muxMu.Lock()
	wait := c.muxPending[resp.ID]
	delete(c.muxPending, resp.ID)
	c.muxMu.Unlock()
	if wait != nil {
		wait <- out
	}
}

func (c *Client) failMux(err error) {
	c.muxMu.Lock()
	pending := c.muxPending
	c.muxPending = map[string]chan rpcOutcome{}
	c.muxMu.Unlock()
	for _, wait := range pending {
		wait <- rpcOutcome{err: err}
	}
}
