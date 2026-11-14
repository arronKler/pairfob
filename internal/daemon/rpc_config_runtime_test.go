package daemon

import (
	"context"
	"testing"

	"pairfob/internal/runtime"
)

// runtimeKindStub reports a descriptor runtime directly, so GetConfig's wire
// vocabulary is tested without depending on the engine's runtime type switch.
type runtimeKindStub struct {
	*runtime.Fake
	kind string
}

func (r *runtimeKindStub) Describe(context.Context, runtime.SessionRef) (runtime.Descriptor, error) {
	return runtime.Descriptor{Runtime: r.kind, Capabilities: map[runtime.Feature]runtime.Capability{
		runtime.FeatureTerminalClientScroll: {Available: r.kind == "herdr-core"},
	}}, nil
}

func TestGetConfigKeepsRuntimeInsideTheWireEnum(t *testing.T) {
	for _, test := range []struct {
		name string
		kind string
		want string
	}{
		{name: "herdr", kind: "herdr", want: "herdr"},
		{name: "herdr-core reports as herdr", kind: "herdr-core", want: "herdr"},
		{name: "fake", kind: "fake", want: "fake"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rt := &runtimeKindStub{Fake: runtime.NewFake(), kind: test.kind}
			_, client := runtimeRPCClient(t, rt)
			raw, err := client.RPC("GetConfig", map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			if got := decodeResult(t, raw)["runtime"]; got != test.want {
				t.Fatalf("runtime=%v want %v: %s", got, test.want, raw)
			}
			capabilities := decodeResult(t, raw)["capabilities"].(map[string]any)
			if got := capabilities["terminal_client_scroll"]; got != (test.kind == "herdr-core") {
				t.Fatalf("terminal_client_scroll=%v runtime=%s", got, test.kind)
			}
		})
	}
}
