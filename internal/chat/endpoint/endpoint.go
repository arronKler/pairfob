// Package endpoint serves pairfob-chat.v1 over a Unix socket. It is a view of
// one hub: it replays a snapshot or the changes after a cursor, then streams
// changes and answers commands.
package endpoint

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/protocol"
)

const (
	defaultMaxViews    = 8
	subscriptionBuffer = 128
)

// Options configures one endpoint.
type Options struct {
	// Path is the socket file.
	Path string
	// Hub is the transcript this endpoint serves.
	Hub *hub.Hub
	// MaxViews overrides the default limit of 8.
	MaxViews int
}

// Server accepts view connections until Close.
type Server struct {
	path string
	hub  *hub.Hub
	ln   net.Listener
	max  int

	mu     sync.Mutex
	conns  map[*conn]struct{}
	closed bool
	wg     sync.WaitGroup
}

// Listen creates the socket directory and binds the socket. The directory is
// mode 0700 when this call creates it; the socket is mode 0600.
func Listen(opts Options) (*Server, error) {
	if opts.Hub == nil {
		return nil, errors.New("endpoint: listen needs a hub")
	}
	if opts.Path == "" {
		return nil, errors.New("endpoint: listen needs a socket path")
	}
	created, err := ensureDir(filepath.Dir(opts.Path))
	if err != nil {
		return nil, fmt.Errorf("endpoint: state directory: %w", err)
	}
	if created {
		if err := os.Chmod(filepath.Dir(opts.Path), 0o700); err != nil {
			return nil, fmt.Errorf("endpoint: state directory mode: %w", err)
		}
	}
	if err := clearStaleSocket(opts.Path); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", opts.Path)
	if err != nil {
		return nil, fmt.Errorf("endpoint: listen %s: %w", opts.Path, err)
	}
	if err := os.Chmod(opts.Path, 0o600); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("endpoint: socket mode: %w", err)
	}
	max := opts.MaxViews
	if max <= 0 {
		max = defaultMaxViews
	}
	return &Server{
		path:  opts.Path,
		hub:   opts.Hub,
		ln:    listener,
		max:   max,
		conns: make(map[*conn]struct{}),
	}, nil
}

// Path is the bound socket file.
func (s *Server) Path() string { return s.path }

// Serve accepts views until Close. It returns nil after a Close.
func (s *Server) Serve() error {
	for {
		nc, err := s.ln.Accept()
		if err != nil {
			if s.isClosed() {
				return nil
			}
			return err
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(nc)
		}()
	}
}

// Close stops the listener, drops every view and removes the socket file.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()

	err := s.ln.Close()
	for _, c := range conns {
		c.close()
	}
	s.wg.Wait()
	if removeErr := os.Remove(s.path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) && err == nil {
		err = removeErr
	}
	return err
}

func (s *Server) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *Server) handle(nc net.Conn) {
	unixConn, ok := nc.(*net.UnixConn)
	if !ok {
		_ = nc.Close()
		return
	}
	if err := checkPeerUID(unixConn); err != nil {
		_ = nc.Close()
		return
	}
	c := newConn(s, nc)
	if !s.register(c) {
		ok := false
		_ = c.send(protocol.ServerMessage{
			V:    protocol.Version,
			Type: protocol.TypeResult,
			ID:   "view-limit",
			OK:   &ok,
			Error: &protocol.Error{
				Code:    protocol.ErrCodeBusy,
				Message: fmt.Sprintf("at most %d views", s.max),
			},
		})
		_ = nc.Close()
		return
	}
	defer s.unregister(c)
	c.serve()
}

func (s *Server) register(c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(s.conns) >= s.max {
		return false
	}
	s.conns[c] = struct{}{}
	return true
}

func (s *Server) unregister(c *conn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func ensureDir(dir string) (bool, error) {
	info, err := os.Stat(dir)
	switch {
	case err == nil:
		if !info.IsDir() {
			return false, fmt.Errorf("%s is not a directory", dir)
		}
		return false, nil
	case !errors.Is(err, os.ErrNotExist):
		return false, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	return true, nil
}

// clearStaleSocket removes a socket left by an earlier process. It refuses to
// replace a non-socket file, which is not ours to delete.
func clearStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("endpoint: inspect %s: %w", path, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("endpoint: %s exists and is not a socket", path)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("endpoint: remove stale socket: %w", err)
	}
	return nil
}

// DefaultDir is $XDG_STATE_HOME/pairfob/chat, defaulting to
// ~/.local/state/pairfob/chat.
func DefaultDir() (string, error) {
	if base := os.Getenv("XDG_STATE_HOME"); base != "" {
		return filepath.Join(base, "pairfob", "chat"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("endpoint: locate home directory: %w", err)
	}
	return filepath.Join(home, ".local", "state", "pairfob", "chat"), nil
}

// SocketPath is the socket file for one chat id.
func SocketPath(dir, id string) string {
	return filepath.Join(dir, id+".sock")
}
