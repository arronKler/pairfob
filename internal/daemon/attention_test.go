package daemon

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

const attentionTestDevice = "dev_12345678"

func attentionTestSubscription() []state.PushSubscription {
	return []state.PushSubscription{{Endpoint: "https://push.example.test/one"}}
}

func attentionTestEngine(t *testing.T) *Engine {
	t.Helper()
	engine := NewEngine(nil, nil, runtime.NewFake())
	engine.PushEnabled = true
	engine.DaemonID = "d_aaaaaaaaaaaaaaaaaaaa"
	engine.Devices[attentionTestDevice] = &Device{
		ID: attentionTestDevice, PushSubscriptions: attentionTestSubscription(),
	}
	return engine
}

func attentionTestSnapshot(status, instance string) runtime.Snapshot {
	return runtime.Snapshot{
		Workspaces: []runtime.Workspace{{WorkspaceID: "w1", Label: "demo"}},
		Tabs:       []runtime.Tab{{TabID: "t1", Label: "main"}},
		Panes: []runtime.Pane{{
			PaneID: "w1:p1", WorkspaceID: "w1", TabID: "t1", TerminalID: "term",
			Agent: "claude", AgentStatus: status, AgentInstanceID: instance,
		}},
	}
}

func backdateAttentionDelivery(t *testing.T, engine *Engine, count int, age time.Duration) {
	t.Helper()
	at := time.Now().Add(-age).Unix()
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, event := range engine.attention {
		if event.PaneID != "w1:p1" || event.ResolvedAt != 0 {
			continue
		}
		for deviceID, delivery := range event.Deliveries {
			if delivery.Count != count {
				continue
			}
			delivery.LastAt = at
			event.Deliveries[deviceID] = delivery
		}
	}
}

func backdateAttentionRetract(t *testing.T, engine *Engine, age time.Duration) {
	t.Helper()
	at := time.Now().Add(-age).Unix()
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for _, event := range engine.attention {
		for deviceID, delivery := range event.Deliveries {
			if delivery.RetractCount == 0 {
				continue
			}
			delivery.RetractAt = at
			event.Deliveries[deviceID] = delivery
		}
	}
}

func openAttentionEvents(engine *Engine) int {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	count := 0
	for _, event := range engine.attention {
		if event.ResolvedAt == 0 {
			count++
		}
	}
	return count
}

func TestAttentionNotifiesOnceAndEscalatesBounded(t *testing.T) {
	engine := attentionTestEngine(t)
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	snapshot := attentionTestSnapshot("blocked", "one")
	engine.reconcileAttention(runtime.DefaultSession(), snapshot, emit)
	if len(pushes) != 1 || pushes[0].Kind != PushNeedsYou || pushes[0].HerdID != "w1:p1" ||
		len(pushes[0].Devices) != 1 || pushes[0].Devices[0] != attentionTestDevice || pushes[0].AttentionAt <= 0 {
		t.Fatalf("first delivery=%+v", pushes)
	}
	engine.reconcileAttention(runtime.DefaultSession(), snapshot, emit)
	if len(pushes) != 1 {
		t.Fatalf("unchanged snapshot repeated the notice: %+v", pushes)
	}
	backdateAttentionDelivery(t, engine, 1, attentionRetryFirst+time.Second)
	engine.reconcileAttention(runtime.DefaultSession(), snapshot, emit)
	if len(pushes) != 2 {
		t.Fatalf("first escalation missing: %d", len(pushes))
	}
	backdateAttentionDelivery(t, engine, 2, attentionRetryNext+time.Second)
	engine.reconcileAttention(runtime.DefaultSession(), snapshot, emit)
	if len(pushes) != 3 {
		t.Fatalf("second escalation missing: %d", len(pushes))
	}
	backdateAttentionDelivery(t, engine, 3, time.Hour)
	engine.reconcileAttention(runtime.DefaultSession(), snapshot, emit)
	if len(pushes) != 3 {
		t.Fatalf("escalated beyond the budget: %d", len(pushes))
	}
}

func TestAttentionSurvivesRestartAndCatchesUpPerDevice(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewPersistentEngine(nil, nil, runtime.NewFake(), store, nil)
	if err != nil {
		t.Fatal(err)
	}
	first.PushEnabled = true
	first.PutDevice(attentionTestDevice, make([]byte, 32))
	userPub, userAuth := testPushSubscriptionKeys(t)
	first.mu.Lock()
	first.Devices[attentionTestDevice].PushSubscriptions = []state.PushSubscription{{
		Endpoint: "https://push.example.test/one", P256DH: userPub, Auth: userAuth,
	}}
	if err := first.saveDevicesLocked(); err != nil {
		first.mu.Unlock()
		t.Fatal(err)
	}
	first.mu.Unlock()
	var firstPushes []HerdPush
	first.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), func(push HerdPush) {
		firstPushes = append(firstPushes, push)
	})
	if len(firstPushes) != 1 {
		t.Fatalf("first engine pushes=%+v", firstPushes)
	}

	second, err := NewPersistentEngine(nil, nil, runtime.NewFake(), store, nil)
	if err != nil {
		t.Fatal(err)
	}
	second.PushEnabled = true
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	second.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 0 {
		t.Fatalf("restart repeated a delivered notice: %+v", pushes)
	}
	backdateAttentionDelivery(t, second, 1, attentionRetryFirst+time.Second)
	second.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 1 {
		t.Fatalf("restart lost the escalation: %+v", pushes)
	}

	second.mu.Lock()
	second.Devices["dev_87654321"] = &Device{ID: "dev_87654321", PushSubscriptions: attentionTestSubscription()}
	second.mu.Unlock()
	second.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 2 || len(pushes[1].Devices) != 1 || pushes[1].Devices[0] != "dev_87654321" {
		t.Fatalf("new device did not catch up alone: %+v", pushes)
	}
}

func TestAttentionRetractsWhenAnswered(t *testing.T) {
	engine := attentionTestEngine(t)
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("working", "one"), emit)
	if len(pushes) != 2 || pushes[1].Kind != PushRetract || pushes[1].HerdID != "w1:p1" {
		t.Fatalf("answer did not retract: %+v", pushes)
	}
	if pushes[1].AttentionAt != pushes[0].AttentionAt {
		t.Fatal("resolution changed the episode order")
	}
	engine.attentionRetracted(pushes[1])
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("working", "one"), emit)
	if len(pushes) != 2 {
		t.Fatalf("retraction repeated after delivery: %+v", pushes)
	}
	if open := openAttentionEvents(engine); open != 0 {
		t.Fatalf("answered episode retained: %d", open)
	}
}

func TestAttentionRetractsUnknownAndReturnsWhenBlockedAgain(t *testing.T) {
	engine := attentionTestEngine(t)
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("unknown", "one"), emit)
	if len(pushes) != 1 || openAttentionEvents(engine) != 1 {
		t.Fatalf("unknown status ended the episode: %+v", pushes)
	}
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 1 {
		t.Fatalf("return to blocked repeated the notice: %+v", pushes)
	}
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("idle", "one"), emit)
	if len(pushes) != 2 || pushes[1].Kind != PushRetract {
		t.Fatalf("idle did not retract: %+v", pushes)
	}
}

func TestAttentionReplacementOccupantRetractsOldEpisodeFirst(t *testing.T) {
	engine := attentionTestEngine(t)
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "two"), emit)
	if len(pushes) != 3 || pushes[1].Kind != PushRetract || pushes[2].Kind != PushNeedsYou {
		t.Fatalf("replacement order=%+v", pushes)
	}
	if pushes[1].AttentionID == pushes[2].AttentionID {
		t.Fatal("replacement shared an attention episode")
	}
}

func TestAttentionRetractRetriesAreBounded(t *testing.T) {
	engine := attentionTestEngine(t)
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("working", "one"), emit)
	if len(pushes) != 2 || pushes[1].Kind != PushRetract {
		t.Fatalf("initial retract=%+v", pushes)
	}
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("working", "one"), emit)
	if len(pushes) != 2 {
		t.Fatalf("retract ignored its backoff: %+v", pushes)
	}
	for attempt := 0; attempt < attentionRetractAttempts; attempt++ {
		backdateAttentionRetract(t, engine, attentionRetractBackoff+time.Second)
		engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("working", "one"), emit)
	}
	retracts := 0
	for _, push := range pushes {
		if push.Kind == PushRetract {
			retracts++
		}
	}
	if retracts != attentionRetractAttempts {
		t.Fatalf("retract attempts=%d want %d", retracts, attentionRetractAttempts)
	}
	if len(engine.attention) != 0 {
		t.Fatalf("exhausted episode retained: %d", len(engine.attention))
	}
}

func TestAttentionWaitsForASubscribedDevice(t *testing.T) {
	engine := NewEngine(nil, nil, runtime.NewFake())
	engine.PushEnabled = true
	engine.DaemonID = "d_aaaaaaaaaaaaaaaaaaaa"
	var pushes []HerdPush
	emit := func(push HerdPush) { pushes = append(pushes, push) }
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 0 {
		t.Fatalf("notified without a subscription: %+v", pushes)
	}
	engine.Devices[attentionTestDevice] = &Device{ID: attentionTestDevice, PushSubscriptions: attentionTestSubscription()}
	engine.reconcileAttention(runtime.DefaultSession(), attentionTestSnapshot("blocked", "one"), emit)
	if len(pushes) != 1 || pushes[0].Kind != PushNeedsYou {
		t.Fatalf("subscription did not catch up: %+v", pushes)
	}
}

func TestAttentionTargetedDeliveryBypassesOtherDevicesAndDebounce(t *testing.T) {
	engine := attentionTestEngine(t)
	pub, priv := testVAPID(t)
	userPub, userAuth := testPushSubscriptionKeys(t)
	transport := &countPushTransport{}
	engine.VAPIDPublic, engine.VAPIDPrivate, engine.VAPIDSubject = pub, priv, "mailto:probe@example.invalid"
	engine.PushHTTPClient = &http.Client{Transport: transport}
	engine.Devices[attentionTestDevice].PushSubscriptions = []state.PushSubscription{{
		Endpoint: "https://push.example.test/one", P256DH: userPub, Auth: userAuth,
	}}
	otherPub, otherAuth := testPushSubscriptionKeys(t)
	engine.Devices["dev_87654321"] = &Device{ID: "dev_87654321", PushSubscriptions: []state.PushSubscription{{
		Endpoint: "https://push.example.test/two", P256DH: otherPub, Auth: otherAuth,
	}}}
	push := HerdPush{HerdID: "w1:p1", Kind: PushNeedsYou, Devices: []string{attentionTestDevice}}
	if err := engine.notifyHerd(context.Background(), push); err != nil {
		t.Fatal(err)
	}
	if calls := transport.calls.Load(); calls != 1 {
		t.Fatalf("targeted delivery reached %d subscriptions", calls)
	}
	// The ledger decides when a device is due; a second scheduled delivery for
	// the same device is not the 30-second transition debounce.
	if err := engine.notifyHerd(context.Background(), push); err != nil {
		t.Fatal(err)
	}
	if calls := transport.calls.Load(); calls != 2 {
		t.Fatalf("ledger delivery was debounced: %d", calls)
	}
}

func TestAttentionPayloadCarriesItsEpisode(t *testing.T) {
	engine := attentionTestEngine(t)
	pub, priv := testVAPID(t)
	engine.VAPIDPublic, engine.VAPIDPrivate, engine.VAPIDSubject = pub, priv, "mailto:probe@example.invalid"
	userKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	userPublic := elliptic.Marshal(elliptic.P256(), userKey.X, userKey.Y)
	authSecret := make([]byte, 16)
	if _, err := rand.Read(authSecret); err != nil {
		t.Fatal(err)
	}
	var body []byte
	engine.PushHTTPClient = &http.Client{Transport: capturePushTransport{capture: func(value []byte) { body = value }}}
	engine.Devices[attentionTestDevice].PushSubscriptions = []state.PushSubscription{{
		Endpoint: "https://push.example.test/one", P256DH: canon.B64URL(userPublic), Auth: canon.B64URL(authSecret),
	}}
	episode := "att_cccccccccccccccccccccccccccccccc"
	if err := engine.notifyHerd(context.Background(), HerdPush{
		HerdID: "w1:p1", Kind: PushNeedsYou, AttentionID: episode, AttentionAt: 1794886800000000001,
		Devices: []string{attentionTestDevice},
	}); err != nil {
		t.Fatal(err)
	}
	plain := decryptPushForTest(t, body, userPublic, authSecret, userKey)
	var fields map[string]string
	if err := json.Unmarshal(plain, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["event"] != episode || fields["event_at"] != "1794886800000000001" || fields["kind"] != "needs_you" || fields["tag"] == "" {
		t.Fatalf("notification fields=%+v", fields)
	}
}

type capturePushTransport struct{ capture func([]byte) }

func (c capturePushTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	value, _ := io.ReadAll(request.Body)
	c.capture(value)
	return &http.Response{StatusCode: http.StatusCreated, Status: "201 Created", Body: http.NoBody, Header: http.Header{}}, nil
}

func TestMonitorFirstFrameBlockedPaneCatchesUp(t *testing.T) {
	engine := attentionTestEngine(t)
	engine.PushEnabled = true
	rt := newMonitorTestRuntime()
	engine.RT = rt
	rt.setSnapshot(attentionTestSnapshot("blocked", "one"))
	monitor := sessionMonitorState{panes: map[string]monitoredPane{}}
	var pushes []HerdPush
	engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &monitor,
		func(string, string) {}, func(push HerdPush) { pushes = append(pushes, push) })
	if len(pushes) != 1 || pushes[0].Kind != PushNeedsYou {
		t.Fatalf("first blocked frame stayed quiet: %+v", pushes)
	}
	engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &monitor,
		func(string, string) {}, func(push HerdPush) { pushes = append(pushes, push) })
	if len(pushes) != 1 {
		t.Fatalf("unchanged frame repeated the notice: %+v", pushes)
	}
	rt.setSnapshot(attentionTestSnapshot("working", "one"))
	engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &monitor,
		func(string, string) {}, func(push HerdPush) { pushes = append(pushes, push) })
	if len(pushes) != 2 || pushes[1].Kind != PushRetract {
		t.Fatalf("answer through the monitor did not retract: %+v", pushes)
	}
}
