package daemon

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"pairfob/internal/runtime"
)

func terminalOperation(index byte) string {
	return "op_terminal_stream_" + string([]byte{'a' + index})
}

func TestTerminalRPCStreamsFramesAndOrdersCommands(t *testing.T) {
	_, client := runtimeRPCClient(t, runtime.NewFake())
	openedRaw, err := client.RPC("TerminalOpen", map[string]any{
		"operation_id": terminalOperation(0), "pane_id": "w0:p1", "cols": 80, "rows": 24, "takeover": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	opened := decodeResult(t, openedRaw)
	terminalID, _ := opened["terminal_id"].(string)
	if opened["operation_id"] != terminalOperation(0) || terminalID == "" || opened["encoding"] != "ansi" {
		t.Fatalf("TerminalOpen result = %s", openedRaw)
	}
	input := base64.StdEncoding.EncodeToString([]byte("hello"))
	inputRaw, err := client.RPC("TerminalInput", map[string]any{
		"operation_id": terminalOperation(1), "terminal_id": terminalID, "seq": 1, "data": input,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result := decodeResult(t, inputRaw); result["accepted_seq"] != float64(1) || result["duplicate"] != false {
		t.Fatalf("TerminalInput result = %s", inputRaw)
	}
	duplicateRaw, err := client.RPC("TerminalInput", map[string]any{
		"operation_id": terminalOperation(2), "terminal_id": terminalID, "seq": 1, "data": input,
	})
	if err != nil || decodeResult(t, duplicateRaw)["duplicate"] != true {
		t.Fatalf("duplicate result=%s err=%v", duplicateRaw, err)
	}
	if _, err := client.RPC("TerminalInput", map[string]any{
		"operation_id": terminalOperation(3), "terminal_id": terminalID, "seq": 3, "data": input,
	}); err == nil || err.Error() != "conflict" {
		t.Fatalf("sequence gap = %v", err)
	}
	if _, err := client.RPC("TerminalResize", map[string]any{
		"operation_id": terminalOperation(4), "terminal_id": terminalID, "seq": 2,
		"cols": 100, "rows": 40, "cell_width_px": 8, "cell_height_px": 16,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("TerminalScroll", map[string]any{
		"operation_id": terminalOperation(5), "terminal_id": terminalID, "seq": 3,
		"direction": "up", "lines": 3, "source": "wheel", "modifiers": 0,
	}); err != nil {
		t.Fatal(err)
	}
	// Drain every frame that raced with its command response.
	if _, err := client.RPC("Ping", map[string]any{"t_ms": 1}); err != nil {
		t.Fatal(err)
	}
	if len(client.Events) < 3 {
		t.Fatalf("terminal events = %d, want initial, input and resize", len(client.Events))
	}
	var sawFull, sawInput, sawResize bool
	for _, raw := range client.Events {
		var event struct {
			Op     string `json:"op"`
			Params struct {
				TerminalID string `json:"terminal_id"`
				Width      int    `json:"width"`
				Height     int    `json:"height"`
				Full       bool   `json:"full"`
				Data       string `json:"data"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &event); err != nil || event.Op != "TerminalFrame" || event.Params.TerminalID != terminalID {
			t.Fatalf("bad terminal event: %s err=%v", raw, err)
		}
		data, err := base64.StdEncoding.DecodeString(event.Params.Data)
		if err != nil {
			t.Fatal(err)
		}
		sawFull = sawFull || event.Params.Full
		sawInput = sawInput || string(data) == "hello"
		sawResize = sawResize || event.Params.Full && event.Params.Width == 100 && event.Params.Height == 40
	}
	if !sawFull || !sawInput || !sawResize {
		t.Fatalf("frame coverage full=%v input=%v resize=%v events=%q", sawFull, sawInput, sawResize, client.Events)
	}
	closedRaw, err := client.RPC("TerminalClose", map[string]any{
		"operation_id": terminalOperation(6), "terminal_id": terminalID,
	})
	if err != nil || decodeResult(t, closedRaw)["closed"] != true {
		t.Fatalf("TerminalClose result=%s err=%v", closedRaw, err)
	}
}

func TestTerminalRPCRequiresOperationIDAndLivePane(t *testing.T) {
	_, client := runtimeRPCClient(t, runtime.NewFake())
	if _, err := client.RPC("TerminalOpen", map[string]any{
		"pane_id": "w0:p1", "cols": 80, "rows": 24, "takeover": false,
	}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("missing operation id = %v", err)
	}
	if _, err := client.RPC("TerminalOpen", map[string]any{
		"operation_id": terminalOperation(0), "pane_id": "missing", "cols": 80, "rows": 24, "takeover": false,
	}); err == nil || err.Error() != "pane_not_found" {
		t.Fatalf("missing pane = %v", err)
	}
}

func TestTerminalOpenReplacesStaleControllerFromSameSession(t *testing.T) {
	_, client := runtimeRPCClient(t, runtime.NewFake())
	open := func(operationID string) string {
		raw, err := client.RPC("TerminalOpen", map[string]any{
			"operation_id": operationID, "pane_id": "w0:p1", "cols": 80, "rows": 24, "takeover": false,
		})
		if err != nil {
			t.Fatal(err)
		}
		terminalID, _ := decodeResult(t, raw)["terminal_id"].(string)
		return terminalID
	}
	first := open(terminalOperation(0))
	second := open(terminalOperation(1))
	if first == "" || second == "" || first == second {
		t.Fatalf("replacement ids first=%q second=%q", first, second)
	}
	if _, err := client.RPC("TerminalInput", map[string]any{
		"operation_id": terminalOperation(2), "terminal_id": first, "seq": 1,
		"data": base64.StdEncoding.EncodeToString([]byte("stale")),
	}); err == nil || err.Error() != "conflict" {
		t.Fatalf("stale controller command = %v", err)
	}
	if _, err := client.RPC("TerminalClose", map[string]any{
		"operation_id": terminalOperation(3), "terminal_id": second,
	}); err != nil {
		t.Fatal(err)
	}
}
