package daemon

import (
	"context"
	"testing"

	"pairfob/internal/runtime"
)

// transcriptStubRuntime reports pane read and transcript separately, so
// GetConfig cannot pass one feature off as the other.
type transcriptStubRuntime struct {
	*runtime.Fake
	paneRead   bool
	transcript bool
}

func (r *transcriptStubRuntime) Describe(context.Context, runtime.SessionRef) (runtime.Descriptor, error) {
	return runtime.Descriptor{
		Runtime: "stub",
		Capabilities: map[runtime.Feature]runtime.Capability{
			runtime.FeaturePaneRead:   {Available: r.paneRead},
			runtime.FeatureTranscript: {Available: r.transcript},
		},
	}, nil
}

func TestGetConfigHistoryFollowsTranscriptBinding(t *testing.T) {
	for _, test := range []struct {
		name       string
		paneRead   bool
		transcript bool
		want       bool
	}{
		{name: "readable pane without a transcript binding", paneRead: true, transcript: false, want: false},
		{name: "transcript binding", paneRead: true, transcript: true, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			rt := &transcriptStubRuntime{Fake: runtime.NewFake(), paneRead: test.paneRead, transcript: test.transcript}
			_, client := runtimeRPCClient(t, rt)
			raw, err := client.RPC("GetConfig", map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			capabilities := decodeResult(t, raw)["capabilities"].(map[string]any)
			if capabilities["history"] != test.want {
				t.Fatalf("history=%v want %v: %s", capabilities["history"], test.want, raw)
			}
		})
	}
}
