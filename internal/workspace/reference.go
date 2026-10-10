package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Reference resolves a chat path without granting a new workspace scope.
type Reference struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

func ResolveReference(root, expectedRoot, home, value string) (Reference, error) {
	canonical, err := canonicalRoot(root)
	if err != nil {
		return Reference{}, err
	}
	if canonical != expectedRoot || value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > MaxPathRunes || strings.Contains(value, "\\") {
		return Reference{}, ErrInvalidPath
	}
	for _, c := range value {
		if unicode.IsControl(c) {
			return Reference{}, ErrInvalidPath
		}
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == ".git" {
			return Reference{}, ErrInvalidPath
		}
	}
	if value == "~" || strings.HasPrefix(value, "~/") {
		if !filepath.IsAbs(home) {
			return Reference{}, ErrInvalidPath
		}
		value = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(value, "~"), "/"))
	}
	if !filepath.IsAbs(value) {
		return Reference{}, ErrInvalidPath
	}
	// Accept the live cwd's lexical spelling as well as its canonical spelling.
	// Check containment before touching the requested path, then again after symlinks.
	base := filepath.Clean(root)
	if within(canonical, value) {
		base = canonical
	}
	if !within(base, value) {
		return Reference{}, ErrInvalidPath
	}
	relative, err := filepath.Rel(base, value)
	if err != nil {
		return Reference{}, ErrInvalidPath
	}
	_, _, resolved, err := resolveExisting(canonical, relative)
	if err != nil {
		return Reference{}, err
	}
	relative, err = filepath.Rel(canonical, resolved)
	if err != nil {
		return Reference{}, ErrInvalidPath
	}
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		if part == ".git" {
			return Reference{}, ErrInvalidPath
		}
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return Reference{}, err
	}
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	} else if !info.Mode().IsRegular() {
		return Reference{}, ErrInvalidPath
	}
	if relative == "." {
		relative = ""
	}
	return Reference{Root: canonical, Path: filepath.ToSlash(relative), Kind: kind}, nil
}
