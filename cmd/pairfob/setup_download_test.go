package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestActivateHerdrChecksIntegrityAndNeverReplaces(t *testing.T) {
	payload := []byte("#!/bin/sh\necho fixture\n")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	for _, existing := range []string{"none", "file", "symlink"} {
		t.Run(existing, func(t *testing.T) {
			dir := t.TempDir()
			dest := filepath.Join(dir, "herdr")
			if existing == "file" {
				if err := os.WriteFile(dest, []byte("keep"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if existing == "symlink" {
				if err := os.Symlink("absent", dest); err != nil {
					t.Fatal(err)
				}
			}
			if err := activateHerdr(dest, payload, strings.Repeat("0", 64)); err == nil {
				t.Fatal("bad hash accepted")
			}
			err := activateHerdr(dest, payload, sum)
			if existing == "none" {
				if err != nil {
					t.Fatal(err)
				}
				got, _ := os.ReadFile(dest)
				info, _ := os.Stat(dest)
				if string(got) != string(payload) || info.Mode().Perm() != 0755 {
					t.Fatalf("invalid installed file: %q", got)
				}
			} else {
				if err == nil {
					t.Fatal("existing installation replaced")
				}
				if existing == "file" {
					got, _ := os.ReadFile(dest)
					if string(got) != "keep" {
						t.Fatal("file changed")
					}
				}
				if existing == "symlink" {
					target, _ := os.Readlink(dest)
					if target != "absent" {
						t.Fatal("symlink changed")
					}
				}
			}
			leftovers, _ := filepath.Glob(filepath.Join(dir, ".herdr-install-*"))
			if len(leftovers) > 0 {
				t.Fatalf("leftovers %v", leftovers)
			}
		})
	}
}

// Opt-in network smoke only installs into a temporary directory, never PATH.
func TestPinnedHerdrDownloadWhenRequested(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_HERDR_DOWNLOAD") != "1" {
		t.Skip("set PAIRFOB_TEST_HERDR_DOWNLOAD=1 for pinned release verification")
	}
	release, ok := herdrReleases[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		t.Skip("unsupported automatic install platform")
	}
	payload, err := fetchHerdrArtifact("https://github.com/herdrdev/herdr/releases/download/v" + bundledHerdrVersion + "/" + release.asset)
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "herdr")
	if err := activateHerdr(dest, payload, release.sha256); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, dest, "--version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "herdr "+bundledHerdrVersion {
		t.Fatalf("version=%q err=%v", out, err)
	}
}

func TestHerdrDownloadRedirectPolicy(t *testing.T) {
	for _, tc := range []struct {
		url  string
		hops int
		ok   bool
	}{
		{"https://release-assets.githubusercontent.com/file", 1, true},
		{"http://release-assets.githubusercontent.com/file", 1, false},
		{"https://example.com/file", 1, false},
		{"https://release-assets.githubusercontent.com.evil.test/file", 1, false},
		{"https://user:pass@release-assets.githubusercontent.com/file", 1, false},
		{"https://release-assets.githubusercontent.com/file", 4, false},
	} {
		parsed, err := url.Parse(tc.url)
		if err != nil {
			t.Fatal(err)
		}
		err = herdrDownloadRedirect(&http.Request{URL: parsed}, make([]*http.Request, tc.hops))
		if (err == nil) != tc.ok {
			t.Fatalf("url=%s hops=%d err=%v", tc.url, tc.hops, err)
		}
	}
}

func TestFetchHerdrArtifactRejectsRedirectBeforeSending(t *testing.T) {
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true); w.WriteHeader(http.StatusOK) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer source.Close()
	_, err := fetchHerdrArtifact(source.URL)
	if !errors.Is(err, errHerdrDownloadRedirect) || reached.Load() {
		t.Fatalf("err=%v reached=%v", err, reached.Load())
	}
}
