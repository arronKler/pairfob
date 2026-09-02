// Package workspace exposes bounded, read-only views of a trusted live workspace.
package workspace

import "errors"

const (
	DefaultListLimit    = 120
	MaxListLimit        = 240
	MaxDirectoryEntries = 20_000
	MaxPreviewBytes     = 128 * 1024
	MaxDiffBytes        = 180 * 1024
	MaxStatusEntries    = 1200
	MaxPathRunes        = 4096
)

var (
	ErrInvalidPath   = errors.New("invalid workspace path")
	ErrNotFound      = errors.New("workspace path not found")
	ErrNotDirectory  = errors.New("workspace path is not a directory")
	ErrNotRepository = errors.New("workspace is not inside a Git repository")
)

type Features struct {
	Files       bool `json:"files"`
	GitStatus   bool `json:"git_status"`
	GitDiff     bool `json:"git_diff"`
	GitBranches bool `json:"git_branches"`
}

type Repository struct {
	Name     string  `json:"name"`
	Branch   *string `json:"branch"`
	Head     string  `json:"head"`
	Detached bool    `json:"detached"`
}

type Descriptor struct {
	Name     string      `json:"name"`
	Root     string      `json:"root"`
	Features Features    `json:"features"`
	Git      *Repository `json:"git"`
}

type Entry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size"`
	ModifiedMS int64  `json:"modified_ms"`
	Hidden     bool   `json:"hidden"`
}

type DirectoryPage struct {
	Path       string  `json:"path"`
	Entries    []Entry `json:"entries"`
	NextCursor *string `json:"next_cursor"`
	Truncated  bool    `json:"truncated"`
	Revision   string  `json:"revision"`
}

type FileView struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size"`
	ModifiedMS int64  `json:"modified_ms"`
	Content    string `json:"content"`
	Truncated  bool   `json:"truncated"`
	Revision   string `json:"revision"`
}

type Change struct {
	Path         string  `json:"path"`
	OriginalPath *string `json:"original_path"`
	Index        string  `json:"index"`
	Worktree     string  `json:"worktree"`
}

type Status struct {
	Branch    *string  `json:"branch"`
	Head      string   `json:"head"`
	Upstream  *string  `json:"upstream"`
	Ahead     int      `json:"ahead"`
	Behind    int      `json:"behind"`
	Changes   []Change `json:"changes"`
	Truncated bool     `json:"truncated"`
	Revision  string   `json:"revision"`
}

type Diff struct {
	Path      string `json:"path"`
	Layer     string `json:"layer"`
	Patch     string `json:"patch"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
	Revision  string `json:"revision"`
}

type Branch struct {
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Current  bool    `json:"current"`
	Head     string  `json:"head"`
	Upstream *string `json:"upstream"`
}

type Branches struct {
	Items     []Branch `json:"items"`
	Truncated bool     `json:"truncated"`
	Revision  string   `json:"revision"`
}
