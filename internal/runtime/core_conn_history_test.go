package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCoreAttachHistoryBelongsToTheViewer(t *testing.T) {
	for _, output := range []bool{false, true} {
		name := "input"
		want := float64(0)
		if output {
			name, want = "viewer", 1000
		}
		t.Run(name, func(t *testing.T) {
			conn, log, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
				return coreScriptReply{result: map[string]any{
					"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24},
				}}
			})
			if err != nil {
				t.Fatal(err)
			}
			if output {
				_, _, err = conn.OpenOutput(context.Background(), "t3", 80, 24)
			} else {
				_, err = conn.OpenInput(context.Background(), "t3", 80, 24)
			}
			if err != nil {
				t.Fatal(err)
			}
			request, ok := log.requestFor("terminal.attach")
			var params map[string]any
			if err := json.Unmarshal(request.params, &params); err != nil || !ok {
				t.Fatalf("attach params=%s err=%v", request.params, err)
			}
			if params["history"] != want {
				t.Fatalf("attach history=%v want %v", params["history"], want)
			}
		})
	}
}
