package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDownloadIdleTimeoutDiscardsPartialAttempt(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "partial")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		fmt.Fprint(w, "complete")
	}))
	defer server.Close()
	var progress []downloadProgress
	got, err := fetchDownloadBytes(server.URL, 1024, downloadPolicy{timeout: 3 * time.Second, idleTimeout: 150 * time.Millisecond, attempts: 2, progress: func(p downloadProgress) { progress = append(progress, p) }})
	if err != nil || string(got) != "complete" {
		t.Fatalf("%q %v", got, err)
	}
	if requests.Load() != 2 || len(progress) != 4 {
		t.Fatalf("requests=%d progress=%+v", requests.Load(), progress)
	}
	if !errors.Is(progress[1].Err, errDownloadIdle) || progress[1].Received != 7 || progress[3].Received != 8 || !progress[3].Done {
		t.Fatalf("bad progress: %+v", progress)
	}
}

func TestDownloadContinuingProgressCanExceedIdleBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 6; i++ {
			fmt.Fprint(w, "x")
			w.(http.Flusher).Flush()
			select {
			case <-time.After(100 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
	}))
	defer server.Close()
	started := time.Now()
	b, err := fetchDownloadBytes(server.URL, 1024, downloadPolicy{timeout: 3 * time.Second, idleTimeout: 500 * time.Millisecond, attempts: 1})
	if err != nil || string(b) != "xxxxxx" {
		t.Fatalf("%q %v", b, err)
	}
	if time.Since(started) < 500*time.Millisecond {
		t.Fatal("fixture did not outlast idle budget")
	}
}

func TestDownloadTotalDeadlineStillBoundsContinuousProgress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for {
			fmt.Fprint(w, "x")
			w.(http.Flusher).Flush()
			select {
			case <-time.After(20 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
	}))
	defer server.Close()
	_, err := fetchDownloadBytes(server.URL, 1<<20, downloadPolicy{timeout: 300 * time.Millisecond, idleTimeout: time.Second, attempts: 1})
	if err == nil || errors.Is(err, errDownloadIdle) {
		t.Fatalf("expected total timeout, got %v", err)
	}
}

func TestDownloadRejectsOversizedHeaderWithoutRetry(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Length", "99999")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	_, err := fetchDownloadBytes(server.URL, 1024, downloadPolicy{timeout: time.Second, attempts: 2})
	if !errors.Is(err, errDownloadTooLarge) || requests.Load() != 1 {
		t.Fatalf("%v requests=%d", err, requests.Load())
	}
}

func TestDownloadReportsUnknownLengthAndRejectsStreamingOversize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		fmt.Fprint(w, "payload")
	}))
	defer server.Close()
	for _, limit := range []int64{100, 3} {
		var last downloadProgress
		_, err := fetchDownloadBytes(server.URL, limit, downloadPolicy{timeout: time.Second, attempts: 1, progress: func(p downloadProgress) { last = p }})
		if last.Total != -1 || !last.Done || last.Received == 0 {
			t.Fatalf("bad progress: %+v", last)
		}
		if limit == 3 && !errors.Is(err, errDownloadTooLarge) {
			t.Fatal(err)
		}
		if limit == 100 && err != nil {
			t.Fatal(err)
		}
	}
}

func TestDownloadStillRejectsRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "https://example.com", 302) }))
	defer server.Close()
	_, err := fetchDownloadBytes(server.URL, 100, downloadPolicy{timeout: time.Second, attempts: 1})
	if err == nil || !strings.Contains(err.Error(), "refusing HTTP redirect") {
		t.Fatal(err)
	}
}
