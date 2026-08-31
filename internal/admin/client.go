package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

var ErrNotRunning = errors.New("pairfob is not running")

func Call(sock string, req Request) (Response, error) {
	path, err := validatePath(sock)
	if err != nil {
		return Response{}, err
	}
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return Response{}, fmt.Errorf("%w at %s", ErrNotRunning, path)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeoutFor(req.Op)))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return Response{}, err
	}
	var resp Response
	if err := json.NewDecoder(io.LimitReader(conn, 1<<20)).Decode(&resp); err != nil {
		return Response{}, err
	}
	if !resp.OK {
		if resp.Error == "" {
			return resp, errors.New("admin request failed")
		}
		return resp, errors.New(resp.Error)
	}
	return resp, nil
}
