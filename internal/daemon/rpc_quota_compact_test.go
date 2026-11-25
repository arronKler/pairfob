package daemon

import (
	"encoding/json"
	"reflect"
	"testing"

	"pairfob/internal/runtime"
)

func TestQuotaCompactCompletionSendsEachAccountOnce(t *testing.T) {
	readings := make([]runtime.QuotaReading, 9)
	sent := map[string]bool{}
	ids := []string{"codex", "claude", "copilot", "cursor", "grok", "antigravity", "deepseek", "opencode-go", "command-code"}
	for i, id := range ids {
		readings[i] = quotaTestReading(id, "ok", "", 25)
		if i < 8 {
			sent[id] = true
		}
	}
	full := quotaStreamCompletion(readings, sent, false)
	compact := quotaStreamCompletion(readings, sent, true)
	if !reflect.DeepEqual(compact["order"], ids) || len(compact["items"].([]runtime.QuotaAccount)) != 1 || len(full["items"].([]runtime.QuotaAccount)) != 9 {
		t.Fatalf("full=%+v compact=%+v", full, compact)
	}
	if _, ok := full["order"]; ok {
		t.Fatal("changed legacy final shape")
	}
	fullBytes, _ := json.Marshal(full)
	compactBytes, _ := json.Marshal(compact)
	var interimBytes int
	for i := 0; i < 8; i += 2 {
		body, _ := json.Marshal(map[string]any{"items": []runtime.QuotaAccount{readings[i].Account, readings[i+1].Account}, "done": false})
		interimBytes += len(body)
	}
	t.Logf("nine account fixture: full final=%d compact final=%d full stream=%d compact stream=%d JSON bytes", len(fullBytes), len(compactBytes), interimBytes+len(fullBytes), interimBytes+len(compactBytes))
	if len(compactBytes) >= len(fullBytes) {
		t.Fatal("compact response did not remove repeated accounts")
	}
	// Empty and warm-cache queries keep JSON arrays, never null.
	empty, _ := json.Marshal(quotaStreamCompletion(nil, nil, true))
	if string(empty) != `{"done":true,"items":[],"order":[]}` {
		t.Fatal(string(empty))
	}
	warm := quotaStreamCompletion(readings, nil, true)
	if len(warm["items"].([]runtime.QuotaAccount)) != 9 {
		t.Fatal("warm read lost accounts")
	}
}

func TestQuotaCompactParamsAreStrictAndOldStreamStillWorks(t *testing.T) {
	e, client := runtimeRPCClient(t, runtime.NewFake())
	e.QuotaSources = func() []runtime.QuotaSource { return nil }
	for _, value := range []any{nil, "true", 1, []bool{true}} {
		if _, err := client.RPC("AgentQuotaStream", map[string]any{"compact": value}); err == nil {
			t.Fatalf("accepted compact=%v", value)
		}
	}
	for _, params := range []map[string]any{{}, {"compact": false}, {"compact": true}} {
		raw, err := client.RPC("AgentQuotaStream", params)
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		_, ordered := result["order"]
		if ordered != (params["compact"] == true) || result["done"] != true {
			t.Fatalf("%s", raw)
		}
	}
}
