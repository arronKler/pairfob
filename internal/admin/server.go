package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

const (
	maxAdminRequest = 4096
	adminTimeout    = 5 * time.Second
	rekeyTimeout    = 20 * time.Second
	pairWaitTimeout = 305 * time.Second
)

func Listen(path string) (net.Listener, error) {
	path, err := validatePath(path)
	if err != nil {
		return nil, err
	}
	if conn, err := net.DialTimeout("unix", path, 200*time.Millisecond); err == nil {
		_ = conn.Close()
		return nil, errors.New("pairfobd already running")
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = ln.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return ln, nil
}

func Serve(ln net.Listener, svc Service) error {
	if svc == nil {
		return errors.New("admin service is required")
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go handleConn(conn, svc)
	}
}

func ListenAndServe(path string, svc Service) error {
	ln, err := Listen(path)
	if err != nil {
		return err
	}
	defer func() {
		_ = ln.Close()
		_ = os.Remove(path)
	}()
	return Serve(ln, svc)
}

func handleConn(conn net.Conn, svc Service) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(adminTimeout))
	var req Request
	if err := json.NewDecoder(io.LimitReader(conn, maxAdminRequest)).Decode(&req); err != nil {
		_ = json.NewEncoder(conn).Encode(errResult(fmt.Errorf("bad_request")))
		return
	}
	_ = conn.SetDeadline(time.Now().Add(timeoutFor(req.Op)))
	_ = json.NewEncoder(conn).Encode(dispatch(svc, req))
}

func timeoutFor(op string) time.Duration {
	if op == "pair.wait" {
		return pairWaitTimeout
	}
	if op == "relay.rekey" {
		return rekeyTimeout
	}
	return adminTimeout
}

func dispatch(svc Service, req Request) Response {
	switch req.Op {
	case "pair.status":
		return okResult(svc.Status())
	case "pair.new":
		st, err := svc.NewPairing()
		if err != nil {
			return errResult(err)
		}
		return okResult(st)
	case "pair.wait":
		if req.PairRef == "" {
			return errResult(errors.New("pair_ref required"))
		}
		st, err := svc.WaitPairingReady(req.PairRef)
		if err != nil {
			return errResult(err)
		}
		return okResult(st)
	case "pair.accept":
		ref := req.PairRef
		if ref == "" {
			ref = svc.Status().Ref
		}
		if ref == "" {
			return errResult(errors.New("no active pairing"))
		}
		if err := svc.Admit(ref); err != nil {
			return errResult(err)
		}
		return okResult(map[string]any{"ok": true, "pair_ref": ref})
	case "pair.deny":
		ref := req.PairRef
		if ref == "" {
			ref = svc.Status().Ref
		}
		if ref == "" {
			return errResult(errors.New("no active pairing"))
		}
		if err := svc.Deny(ref); err != nil {
			return errResult(err)
		}
		return okResult(map[string]any{"ok": true, "pair_ref": ref})
	case "device.list":
		devices := svc.Devices()
		if devices == nil {
			devices = []Device{}
		}
		return okResult(map[string]any{"devices": devices})
	case "device.revoke":
		if req.DeviceID == "" {
			return errResult(errors.New("device_id required"))
		}
		if err := svc.Revoke(req.DeviceID); err != nil {
			return errResult(err)
		}
		return okResult(map[string]any{"ok": true, "device_id": req.DeviceID})
	case "relay.rekey":
		relay, err := svc.Rekey()
		if err != nil {
			return errResult(err)
		}
		return okResult(map[string]any{"ok": true, "protocol": relay.Protocol, "url": relay.URL})
	default:
		return errResult(errors.New("unknown_op"))
	}
}

func okResult(v any) Response {
	body, err := json.Marshal(v)
	if err != nil {
		return errResult(err)
	}
	return Response{OK: true, Result: body}
}

func errResult(err error) Response {
	msg := "admin request failed"
	if err != nil && err.Error() != "" {
		msg = err.Error()
	}
	return Response{OK: false, Error: msg}
}
