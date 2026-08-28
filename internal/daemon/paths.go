package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func resolvedPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute = filepath.Clean(absolute)
	probe := absolute
	tail := []string{}
	for {
		if _, err := os.Lstat(probe); err == nil {
			resolved, err := filepath.EvalSymlinks(probe)
			if err != nil {
				return "", err
			}
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return filepath.Clean(resolved), nil
		} else if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", errors.New("path has no existing trusted ancestor")
		}
		tail = append(tail, filepath.Base(probe))
		probe = parent
	}
}

func withinPath(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func configuredAllowedRoots() ([]string, error) {
	configured, explicitlyConfigured := os.LookupEnv("PAIRFOB_ALLOWED_ROOTS")
	entries := filepath.SplitList(configured)
	if !explicitlyConfigured {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return nil, errors.New("cannot determine the default user home allowed root")
		}
		entries = []string{home}
	}

	roots := make([]string, 0, len(entries))
	for _, configured := range entries {
		if configured == "" || !filepath.IsAbs(configured) {
			return nil, errors.New("PAIRFOB_ALLOWED_ROOTS entries must be absolute paths")
		}
		info, err := os.Stat(configured)
		if err != nil || !info.IsDir() {
			return nil, errors.New("PAIRFOB_ALLOWED_ROOTS entries must be existing directories")
		}
		root, err := resolvedPath(configured)
		if err != nil {
			return nil, errors.New("PAIRFOB_ALLOWED_ROOTS entry cannot be canonicalized")
		}
		roots = append(roots, root)
	}
	return roots, nil
}

func ValidateAllowedRoots() error {
	_, err := configuredAllowedRoots()
	return err
}

// pathAllowed limits Web-selected directories to live Herdr workspace/pane
// roots or the configured allowlist. The allowlist defaults to the daemon
// user's home unless PAIRFOB_ALLOWED_ROOTS is explicitly set. Worktree creation
// may additionally use a sibling of a live checkout, matching Git's common
// worktree layout.
func (e *Engine) pathAllowed(session *string, candidate string, allowWorkspaceSibling bool) error {
	resolvedCandidate, err := resolvedPath(candidate)
	if err != nil {
		return err
	}
	snapshot, err := e.snapshot(session)
	if err != nil {
		return err
	}
	configuredRoots, err := configuredAllowedRoots()
	if err != nil {
		return err
	}
	roots := make([]string, 0, len(snapshot.Workspaces)+len(snapshot.Panes)+len(configuredRoots))
	workspaceRoots := make([]string, 0, len(snapshot.Workspaces))
	for _, workspace := range snapshot.Workspaces {
		if workspace.Cwd == "" || !filepath.IsAbs(workspace.Cwd) {
			continue
		}
		root, rootErr := resolvedPath(workspace.Cwd)
		if rootErr != nil {
			continue
		}
		roots = append(roots, root)
		workspaceRoots = append(workspaceRoots, root)
	}
	// Herdr 0.8 protocol 19 reports cwd on panes rather than workspaces. Treat
	// every canonical live pane cwd as a trusted root so the Web can reuse the
	// same directories already open in Herdr.
	for _, pane := range snapshot.Panes {
		if pane.Cwd == "" || !filepath.IsAbs(pane.Cwd) {
			continue
		}
		if root, rootErr := resolvedPath(pane.Cwd); rootErr == nil {
			roots = append(roots, root)
		}
	}
	roots = append(roots, configuredRoots...)
	for _, root := range roots {
		if withinPath(root, resolvedCandidate) {
			return nil
		}
	}
	if allowWorkspaceSibling {
		for _, root := range workspaceRoots {
			if resolvedCandidate != root && filepath.Dir(resolvedCandidate) == filepath.Dir(root) {
				return nil
			}
		}
	}
	return errors.New("path is outside live Herdr roots and PAIRFOB_ALLOWED_ROOTS")
}
