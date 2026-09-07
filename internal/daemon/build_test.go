package daemon

import (
	"pairfob/internal/runtime"
	"strings"
	"testing"
)

func TestConfigReturnsRunningBuild(t *testing.T) {
	e, c := runtimeRPCClient(t, runtime.NewFake())
	e.Build = "2026-09-07.10"
	raw, err := c.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"build":"2026-09-07.10"`) {
		t.Fatal(string(raw))
	}
}
