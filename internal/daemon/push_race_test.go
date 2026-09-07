package daemon

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

type holdRoundTripper struct {
	started chan struct{}
	once    sync.Once
}

func (h *holdRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	h.once.Do(func() { close(h.started) })
	<-req.Context().Done()
	return nil, errors.New("in-flight push failed")
}

func TestDeliverPushFailureRaceOnCancel(t *testing.T) {
	for i := 0; i < 5; i++ {
		runDeliverPushCancelRace(t)
	}
}

func runDeliverPushCancelRace(t *testing.T) {
	t.Helper()
	pub, priv := testVAPID(t)
	userPub, userAuth := testPushSubscriptionKeys(t)
	eng := NewEngine(nil, nil, runtime.NewFake())
	eng.VAPIDPublic, eng.VAPIDPrivate, eng.VAPIDSubject = pub, priv, "mailto:probe@example.invalid"
	started := make(chan struct{})
	eng.PushHTTPClient = &http.Client{Transport: &holdRoundTripper{started: started}}
	eng.pushSem = make(chan struct{}, 1)
	subs := []state.PushSubscription{
		{Endpoint: "https://push.example.test/a", P256DH: userPub, Auth: userAuth},
		{Endpoint: "https://push.example.test/b", P256DH: userPub, Auth: userAuth},
	}
	eng.Devices["dev_12345678"] = &Device{ID: "dev_12345678", PushSubscriptions: subs}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- eng.deliverPush(ctx, "dev_12345678", []byte("x")) }()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight push never started")
	}
	cancel()
	var err error
	select {
	case err = <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("deliverPush did not return after cancel")
	}
	if err == nil {
		t.Fatal("expected aggregated push failures")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("missing context cancellation in %v", err)
	}
	if !strings.Contains(err.Error(), "in-flight push failed") {
		t.Fatalf("missing in-flight failure in %v", err)
	}
}

func testVAPID(t *testing.T) (string, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	priv := key.D.FillBytes(make([]byte, 32))
	return canon.B64URL(elliptic.Marshal(elliptic.P256(), key.X, key.Y)), priv
}

func testPushSubscriptionKeys(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return canon.B64URL(elliptic.Marshal(elliptic.P256(), key.X, key.Y)), canon.B64URL(auth)
}
