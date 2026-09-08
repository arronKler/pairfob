package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"time"
)

// ProcessInfo identifies one running image. It is local-only and contains no
// daemon keys, device credentials, pairing codes, or relay credentials.
type ProcessInfo struct {
	PID        int    `json:"pid"`
	Version    string `json:"version"`
	Executable string `json:"executable"`
	SHA256     string `json:"sha256"`
	StateDir   string `json:"state_dir"`
	Instance   string `json:"instance"`
}

type ProcessService interface {
	ProcessInfo() ProcessInfo
	StopProcess()
}

// A stop is bound to the observed instance. Finish writing its acknowledgement
// before allowing the main goroutine to exit and close the process.
func handleProcess(conn net.Conn, svc Service, req Request) bool {
	if req.Op != "daemon.info" && req.Op != "daemon.stop" {
		return false
	}
	process, ok := svc.(ProcessService)
	if !ok {
		_ = json.NewEncoder(conn).Encode(errResult(errors.New("unknown_op")))
		return true
	}
	info := process.ProcessInfo()
	if req.Op == "daemon.info" {
		_ = json.NewEncoder(conn).Encode(okResult(info))
		return true
	}
	if req.Instance == "" || req.Instance != info.Instance {
		_ = json.NewEncoder(conn).Encode(errResult(errors.New("running instance changed; inspect it again")))
		return true
	}
	u, ok := conn.(*net.UnixConn)
	if !ok {
		return true
	}
	_, uid, err := peerCredentials(u)
	if err != nil || uid != uint32(os.Getuid()) {
		_ = json.NewEncoder(conn).Encode(errResult(errors.New("cannot verify local operator")))
		return true
	}
	if err := json.NewEncoder(conn).Encode(okResult(map[string]bool{"stopping": true})); err == nil {
		_ = conn.Close()
		process.StopProcess()
	}
	return true
}

type Peer struct {
	Conn *net.UnixConn
	PID  int
	UID  uint32
}

// OpenPeer retains the connection while a caller inspects its kernel identity.
func OpenPeer(sock string) (*Peer, error) {
	path, err := validatePath(sock)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || isRefused(err) {
			return nil, ErrNotRunning
		}
		return nil, err
	}
	u := conn.(*net.UnixConn)
	pid, uid, err := peerCredentials(u)
	if err != nil || uid != uint32(os.Getuid()) {
		u.Close()
		return nil, errors.New("cannot verify local daemon owner")
	}
	return &Peer{Conn: u, PID: pid, UID: uid}, nil
}

func (p *Peer) Request(req Request) (Response, error) {
	_ = p.Conn.SetDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewEncoder(p.Conn).Encode(req); err != nil {
		return Response{}, err
	}
	var response Response
	err := json.NewDecoder(io.LimitReader(p.Conn, 1<<20)).Decode(&response)
	return response, err
}

func (p *Peer) Close() { _ = p.Conn.Close() }
