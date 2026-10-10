package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func fileIsTTY(file *os.File) bool {
	_, err := unix.IoctlGetTermios(int(file.Fd()), unix.TCGETS)
	return err == nil
}
