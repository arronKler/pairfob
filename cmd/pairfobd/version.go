package main

import (
	"fmt"
	"runtime"
	"strings"
)

var (
	version = "dev"
	commit  = ""
)

func versionCommand() error {
	fmt.Print(versionLine())
	return nil
}

func versionLine() string {
	var b strings.Builder
	fmt.Fprintf(&b, "pairfobd %s %s/%s", version, runtime.GOOS, runtime.GOARCH)
	if commit != "" {
		fmt.Fprintf(&b, " (%s)", commit)
	}
	b.WriteByte('\n')
	return b.String()
}

func artifactName(goos, goarch string) string {
	return "pairfobd-" + goos + "-" + goarch
}
