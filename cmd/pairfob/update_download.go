package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	maxUpdateBytes            = 64 << 20
	updateMetadataTimeout     = 30 * time.Second
	updateArtifactTimeout     = 10 * time.Minute
	updateArtifactIdleTimeout = 45 * time.Second
	updateArtifactAttempts    = 2
	updateRetryDelay          = 500 * time.Millisecond
)

var errDownloadTooLarge = errors.New("download exceeded size limit")
var errDownloadIdle = errors.New("download made no progress before the idle timeout")

type downloadProgress struct {
	Attempt, Attempts int
	Received, Total   int64
	Elapsed           time.Duration
	Done              bool
	Err               error
}

type downloadPolicy struct {
	timeout     time.Duration
	idleTimeout time.Duration
	attempts    int
	retryDelay  time.Duration
	progress    func(downloadProgress)
}

type downloadStatusError int

func (e downloadStatusError) Error() string { return fmt.Sprintf("HTTP %d", int(e)) }

func fetchDownloadText(rawURL string, limit int64) (string, error) {
	b, err := fetchDownloadBytes(rawURL, limit, downloadPolicy{timeout: updateMetadataTimeout, attempts: 1})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func fetchDownloadArtifact(rawURL string) ([]byte, error) {
	return fetchDownloadBytes(rawURL, maxUpdateBytes, downloadPolicy{
		timeout: updateArtifactTimeout, idleTimeout: updateArtifactIdleTimeout,
		attempts: updateArtifactAttempts, retryDelay: updateRetryDelay, progress: printDownloadProgress,
	})
}

func printDownloadProgress(p downloadProgress) {
	total := "unknown total"
	if p.Total >= 0 {
		total = fmt.Sprintf("%.1f MiB", float64(p.Total)/(1<<20))
	}
	label := "Downloading"
	if p.Done && p.Err == nil {
		label = "Downloaded"
	}
	fmt.Fprintf(os.Stderr, "%s attempt %d/%d: %.1f MiB / %s, %s", label, p.Attempt, p.Attempts, float64(p.Received)/(1<<20), total, p.Elapsed.Round(time.Second))
	if p.Err != nil {
		fmt.Fprintf(os.Stderr, " — %v", p.Err)
		if p.Attempt < p.Attempts && retryableDownloadError(p.Err) {
			fmt.Fprint(os.Stderr, "; retrying from the beginning")
		}
	}
	fmt.Fprintln(os.Stderr)
}

func fetchDownloadBytes(rawURL string, limit int64, policy downloadPolicy) ([]byte, error) {
	if policy.attempts < 1 {
		policy.attempts = 1
	}
	var lastErr error
	for attempt := 1; attempt <= policy.attempts; attempt++ {
		payload, err := downloadAttempt(rawURL, limit, policy, attempt)
		if err == nil {
			return payload, nil
		}
		lastErr = err
		if attempt == policy.attempts || !retryableDownloadError(err) {
			break
		}
		if policy.retryDelay > 0 {
			time.Sleep(policy.retryDelay)
		}
	}
	return nil, lastErr
}

func downloadAttempt(rawURL string, limit int64, policy downloadPolicy, attempt int) (payload []byte, resultErr error) {
	started := time.Now()
	progress := downloadProgress{Attempt: attempt, Attempts: policy.attempts, Total: -1}
	emit := func(done bool) {
		progress.Elapsed = time.Since(started)
		progress.Done = done
		progress.Err = resultErr
		if policy.progress != nil {
			policy.progress(progress)
		}
	}
	emit(false)
	defer func() { emit(true) }()
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	var idle *time.Timer
	if policy.idleTimeout > 0 {
		idle = time.AfterFunc(policy.idleTimeout, func() { cancel(errDownloadIdle) })
		defer idle.Stop()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := originHTTPClient(policy.timeout).Do(req)
	if err != nil {
		if cause := context.Cause(ctx); cause != nil {
			return nil, cause
		}
		return nil, err
	}
	defer resp.Body.Close()
	progress.Total = resp.ContentLength
	if resp.StatusCode != http.StatusOK {
		return nil, downloadStatusError(resp.StatusCode)
	}
	if resp.ContentLength > limit {
		return nil, errDownloadTooLarge
	}
	reader := io.LimitReader(resp.Body, limit+1)
	lastReport := time.Now()
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			payload = append(payload, buffer[:n]...)
			progress.Received += int64(n)
			if progress.Received > limit {
				return nil, errDownloadTooLarge
			}
			if idle != nil {
				idle.Reset(policy.idleTimeout)
			}
			if time.Since(lastReport) >= 5*time.Second {
				emit(false)
				lastReport = time.Now()
			}
		}
		if readErr == io.EOF {
			return payload, nil
		}
		if readErr != nil {
			if cause := context.Cause(ctx); cause != nil {
				readErr = cause
			}
			total := "unknown total"
			if progress.Total >= 0 {
				total = fmt.Sprintf("%d", progress.Total)
			}
			return nil, fmt.Errorf("received %d bytes (total %s) after %s: %w", progress.Received, total, time.Since(started).Round(time.Second), readErr)
		}
	}
}

func retryableDownloadError(err error) bool {
	var status downloadStatusError
	if errors.As(err, &status) {
		code := int(status)
		return code == http.StatusRequestTimeout || code == http.StatusTooManyRequests || code >= 500
	}
	return !errors.Is(err, errDownloadTooLarge)
}
