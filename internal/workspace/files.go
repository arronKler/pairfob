package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type Inspector struct{}

func NewInspector() *Inspector { return &Inspector{} }

func hasBinaryControl(data []byte) bool {
	for _, value := range data {
		if (value < 0x20 && value != '\t' && value != '\n' && value != '\r') || value == 0x7f {
			return true
		}
	}
	return false
}

func (i *Inspector) Describe(root string) (Descriptor, error) {
	root, err := canonicalRoot(root)
	if err != nil {
		return Descriptor{}, err
	}
	descriptor := Descriptor{
		Name: filepath.Base(root), Root: root,
		Features: Features{Files: true},
	}
	if repo, repoErr := i.repository(root); repoErr == nil {
		descriptor.Git = &Repository{Name: filepath.Base(repo.root), Branch: repo.branch, Head: repo.head, Detached: repo.branch == nil}
		descriptor.Features.GitStatus = true
		descriptor.Features.GitDiff = true
		descriptor.Features.GitBranches = true
	} else if !errors.Is(repoErr, ErrNotRepository) {
		return Descriptor{}, repoErr
	}
	return descriptor, nil
}

func (i *Inspector) List(root, relative, cursor string, limit int) (DirectoryPage, error) {
	_, clean, directory, err := resolveExisting(root, relative)
	if err != nil {
		return DirectoryPage{}, err
	}
	info, err := os.Stat(directory)
	if err != nil {
		return DirectoryPage{}, err
	}
	if !info.IsDir() {
		return DirectoryPage{}, ErrNotDirectory
	}
	start := 0
	if cursor != "" {
		start, err = strconv.Atoi(cursor)
		if err != nil || start < 0 {
			return DirectoryPage{}, ErrInvalidPath
		}
	}
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaxListLimit {
		limit = MaxListLimit
	}
	handle, err := os.Open(directory)
	if err != nil {
		return DirectoryPage{}, err
	}
	defer handle.Close()
	raw, readErr := handle.ReadDir(MaxDirectoryEntries + 1)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return DirectoryPage{}, readErr
	}
	directoryTruncated := len(raw) > MaxDirectoryEntries
	if directoryTruncated {
		raw = raw[:MaxDirectoryEntries]
	}
	entries := make([]Entry, 0, len(raw))
	for _, item := range raw {
		if item.Name() == ".git" {
			continue
		}
		entryInfo, infoErr := item.Info()
		if infoErr != nil {
			continue
		}
		kind := "other"
		switch {
		case item.Type()&os.ModeSymlink != 0:
			kind = "symlink"
		case item.IsDir():
			kind = "directory"
		case entryInfo.Mode().IsRegular():
			kind = "file"
		}
		path := item.Name()
		if clean != "" {
			path = clean + "/" + item.Name()
		}
		normalized, pathErr := cleanRelative(path)
		if pathErr != nil || normalized == "" {
			directoryTruncated = true
			continue
		}
		entries = append(entries, Entry{
			Name: item.Name(), Path: normalized, Kind: kind, Size: entryInfo.Size(),
			ModifiedMS: entryInfo.ModTime().UnixMilli(), Hidden: strings.HasPrefix(item.Name(), "."),
		})
	}
	sort.Slice(entries, func(left, right int) bool {
		leftDir := entries[left].Kind == "directory"
		rightDir := entries[right].Kind == "directory"
		if leftDir != rightDir {
			return leftDir
		}
		foldLeft, foldRight := strings.ToLower(entries[left].Name), strings.ToLower(entries[right].Name)
		if foldLeft != foldRight {
			return foldLeft < foldRight
		}
		return entries[left].Name < entries[right].Name
	})
	hash := sha256.New()
	for _, entry := range entries {
		_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%d\x00%d\n", entry.Path, entry.Kind, entry.Size, entry.ModifiedMS)
	}
	if start > len(entries) {
		return DirectoryPage{}, ErrInvalidPath
	}
	end := start
	encodedSize := 0
	for end < len(entries) && end < start+limit {
		nextSize := encodedJSONSize(entries[end])
		if end > start && encodedSize+nextSize > MaxResultJSONBytes {
			break
		}
		encodedSize += nextSize
		end++
	}
	var next *string
	if end < len(entries) {
		value := strconv.Itoa(end)
		next = &value
	}
	return DirectoryPage{
		Path: clean, Entries: entries[start:end], NextCursor: next,
		Truncated: directoryTruncated, Revision: hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

func (i *Inspector) Read(root, relative string) (FileView, error) {
	root, clean, resolved, err := resolveExisting(root, relative)
	if err != nil || clean == "" {
		if err == nil {
			err = ErrInvalidPath
		}
		return FileView{}, err
	}
	path := filepath.Join(root, filepath.FromSlash(clean))
	info, err := os.Lstat(path)
	if err != nil {
		return FileView{}, err
	}
	if !info.Mode().IsRegular() {
		return FileView{}, ErrInvalidPath
	}
	file, err := os.Open(resolved)
	if err != nil {
		return FileView{}, err
	}
	defer file.Close()
	buffer, err := io.ReadAll(io.LimitReader(file, MaxPreviewBytes+1))
	if err != nil {
		return FileView{}, err
	}
	truncated := len(buffer) > MaxPreviewBytes || info.Size() > MaxPreviewBytes
	if len(buffer) > MaxPreviewBytes {
		buffer = buffer[:MaxPreviewBytes]
	}
	kind := "text"
	if truncated && !utf8.Valid(buffer) {
		// A bounded read may split one UTF-8 code point. Removing at most its
		// three trailing continuation bytes is safe; deeper invalid data is
		// binary rather than a text preview to be silently shortened.
		for trim := 1; trim <= 3 && trim <= len(buffer); trim++ {
			if utf8.Valid(buffer[:len(buffer)-trim]) {
				buffer = buffer[:len(buffer)-trim]
				break
			}
		}
	}
	content := string(buffer)
	if hasBinaryControl(buffer) || !utf8.Valid(buffer) {
		kind, content, truncated = "binary", "", false
	} else {
		var encodedTruncated bool
		content, encodedTruncated = truncateJSONText(content, MaxResultJSONBytes)
		truncated = truncated || encodedTruncated
	}
	sum := sha256.Sum256(buffer)
	return FileView{
		Path: clean, Kind: kind, Size: info.Size(), ModifiedMS: info.ModTime().UnixMilli(),
		Content: content, Truncated: truncated, Revision: hex.EncodeToString(sum[:]),
	}, nil
}
