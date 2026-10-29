package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestQuotaKeychainNativeQuery(t *testing.T) {
	if !NativeQuotaKeychainAvailable() || os.Getenv("PAIRFOB_TEST_KEYCHAIN") != "1" {
		t.Skip("set PAIRFOB_TEST_KEYCHAIN=1 on a native macOS build")
	}
	_, err := quotaKeychainRead(context.Background(), "pairfob-nonexistent-quota-test-credential", "pairfob-test", 16384)
	if !errors.Is(err, errQuotaKeychainNotFound) {
		t.Fatalf("native query: %v", err)
	}
}

func TestQuotaKeychainPreservesClaudeCredentialJSON(t *testing.T) {
	data := []byte(`{"claudeAiOauth":{"accessToken":"fixture-token","scopes":["user:profile"]},"padding":"` + strings.Repeat("x", 20000) + `"}`)
	raw, err := newKeychainReader().read(context.Background(), "claude", quotaKeychains["claude"], false, func(_ quotaKeychainSpec, interactive bool) ([]byte, error) {
		if interactive {
			t.Error("background read allowed UI")
		}
		return data, nil
	})
	var auth claudeQuotaAuth
	if err != nil || json.Unmarshal(raw, &auth) != nil || auth.OAuth.AccessToken != "fixture-token" {
		t.Fatal("credential changed")
	}
}

func TestQuotaKeychainPausesDeniedConcurrentReadsUntilLocalRetry(t *testing.T) {
	r := newKeychainReader()
	var calls atomic.Int32
	read := func(_ quotaKeychainSpec, interactive bool) ([]byte, error) {
		calls.Add(1)
		if interactive {
			t.Error("unexpected UI")
		}
		return nil, errQuotaKeychainInteraction
	}
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.read(context.Background(), "cursor", quotaKeychains["cursor"], false, read)
			if !errors.Is(err, errQuotaKeychainInteraction) {
				t.Errorf("%v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("%d native calls after denial", calls.Load())
	}
	r.reset("cursor")
	_, _ = r.read(context.Background(), "cursor", quotaKeychains["cursor"], false, read)
	if calls.Load() != 2 {
		t.Fatal("local retry did not clear pause")
	}
}

func TestQuotaKeychainTimeoutDoesNotStartMoreNativeCalls(t *testing.T) {
	r := newKeychainReader()
	release := make(chan struct{})
	started := make(chan struct{})
	var calls atomic.Int32
	read := func(_ quotaKeychainSpec, _ bool) ([]byte, error) {
		calls.Add(1)
		close(started)
		<-release
		return []byte("discarded"), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := r.read(ctx, "cursor", quotaKeychains["cursor"], false, read)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("%v", err)
	}
	<-started
	ctx2, cancel2 := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel2()
	_, err = r.read(ctx2, "cursor", quotaKeychains["cursor"], false, read)
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
	close(release)
	// Await the outstanding reader before the test returns.
	r.gate <- struct{}{}
	<-r.gate
	if r.diagnostics["cursor"].State != "timeout" || r.diagnostics["cursor"].Paused {
		t.Fatal("timeout was labelled denied")
	}
}

func TestQuotaKeychainResetCannotBeUndoneByOldRead(t *testing.T) {
	r := newKeychainReader()
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		_, _ = r.read(context.Background(), "cursor", quotaKeychains["cursor"], false, func(quotaKeychainSpec, bool) ([]byte, error) {
			close(started)
			<-release
			return nil, errQuotaKeychainInteraction
		})
	}()
	<-started
	r.reset("cursor")
	close(release)
	<-finished
	if len(r.diagnostics) != 0 {
		t.Fatal("old read restored stale pause")
	}
}

func TestQuotaKeychainExplicitConsentResumesSilentReads(t *testing.T) {
	r := newKeychainReader()
	spec := quotaKeychains["cursor"]
	_, _ = r.read(context.Background(), "cursor", spec, false, func(quotaKeychainSpec, bool) ([]byte, error) {
		return nil, errQuotaKeychainInteraction
	})
	for _, interactive := range []bool{true, false} {
		raw, err := r.read(context.Background(), "cursor", spec, interactive, func(_ quotaKeychainSpec, allow bool) ([]byte, error) {
			if allow != interactive {
				t.Error("wrong interaction mode")
			}
			return []byte("fixture-secret"), nil
		})
		if err != nil || string(raw) != "fixture-secret" {
			t.Fatalf("read: %v", err)
		}
	}
	encoded, err := json.Marshal(r.diagnostics)
	if err != nil || strings.Contains(string(encoded), "fixture-secret") || r.diagnostics["cursor"].Paused {
		t.Fatal("diagnosis exposed a credential or kept a successful read paused")
	}
}
