package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

func canonicalRoot(root string) (string, error) {
	if root == "" || !filepath.IsAbs(root) || !utf8.ValidString(root) || strings.ContainsRune(root, 0) {
		return "", ErrInvalidPath
	}
	for _, value := range root {
		if unicode.IsControl(value) {
			return "", ErrInvalidPath
		}
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", ErrNotDirectory
	}
	return filepath.Clean(resolved), nil
}

func cleanRelative(relative string) (string, error) {
	if !utf8.ValidString(relative) || utf8.RuneCountInString(relative) > MaxPathRunes || strings.ContainsRune(relative, 0) || filepath.IsAbs(relative) || strings.HasPrefix(relative, "\\") {
		return "", ErrInvalidPath
	}
	for _, value := range relative {
		if unicode.IsControl(value) {
			return "", ErrInvalidPath
		}
	}
	clean := filepath.Clean(filepath.FromSlash(relative))
	if clean == "." {
		return "", nil
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	if clean == ".git" || strings.HasPrefix(clean, ".git"+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	return filepath.ToSlash(clean), nil
}

func within(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func resolveExisting(root, relative string) (string, string, string, error) {
	root, err := canonicalRoot(root)
	if err != nil {
		return "", "", "", err
	}
	clean, err := cleanRelative(relative)
	if err != nil {
		return "", "", "", err
	}
	candidate := root
	if clean != "" {
		candidate = filepath.Join(root, filepath.FromSlash(clean))
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "", "", ErrNotFound
		}
		return "", "", "", err
	}
	if !within(root, resolved) {
		return "", "", "", ErrInvalidPath
	}
	return root, clean, resolved, nil
}

func validateGitPath(root, relative string) (string, string, error) {
	root, err := canonicalRoot(root)
	if err != nil {
		return "", "", err
	}
	clean, err := cleanRelative(relative)
	if err != nil || clean == "" {
		return "", "", ErrInvalidPath
	}
	candidate := filepath.Join(root, filepath.FromSlash(clean))
	probe := candidate
	for {
		resolved, resolveErr := filepath.EvalSymlinks(probe)
		if resolveErr == nil {
			if !within(root, resolved) {
				return "", "", ErrInvalidPath
			}
			break
		}
		if !errors.Is(resolveErr, os.ErrNotExist) {
			return "", "", resolveErr
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", "", ErrInvalidPath
		}
		probe = parent
	}
	return root, clean, nil
}
