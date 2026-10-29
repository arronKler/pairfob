package workspace

import (
	"os"
	"path/filepath"
	"runtime"
)

// A shell often starts in HOME. Treating that cwd as a recursive project scan
// can visit Photos, Downloads and other apps' containers and raise macOS privacy
// prompts. Directory browsing and explicit file operations remain available;
// recursive search and Git discovery require a more specific workspace.
func broadScanRoot(root string) bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return true
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		return true
	}
	return containsHome(root, home)
}

func containsHome(root, home string) bool {
	return within(root, home)
}
