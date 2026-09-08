package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"pairfob/internal/admin"
)

func newProcessInfo(dir string) (admin.ProcessInfo, error) {
	exe, err := resolvedExecutable()
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	image := exe
	if runtime.GOOS == "linux" {
		image = "/proc/self/exe"
	}
	hash, err := executableHash(image)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return admin.ProcessInfo{}, err
	}
	return admin.ProcessInfo{PID: os.Getpid(), Version: version, Executable: exe, SHA256: hash, StateDir: dir, Instance: hex.EncodeToString(nonce[:])}, nil
}

func executableHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxUpdateBytes+1))
	if err != nil {
		return "", err
	}
	if len(b) == 0 || len(b) > maxUpdateBytes {
		return "", errors.New("invalid executable size")
	}
	return sha256Hex(b), nil
}

func (a liveAdmin) ProcessInfo() admin.ProcessInfo { return a.process }
func (a liveAdmin) StopProcess() {
	if a.stop != nil {
		a.stop()
	}
}
