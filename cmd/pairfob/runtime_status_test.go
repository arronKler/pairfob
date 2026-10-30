package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

func TestRuntimeCommandJSON(t *testing.T) {
	t.Setenv("PAIRFOB_DEV_FAKE_RUNTIME", "1")
	var out bytes.Buffer
	if err := writeRuntimeCommand(&out, []string{"--json"}); err != nil {
		t.Fatal(err)
	}
	var status runtimeStatus
	if err := json.Unmarshal(out.Bytes(), &status); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if status.Kind != runtime.RuntimeKindFake || status.Source != "fake:explicit-dev" {
		t.Fatalf("status=%+v", status)
	}
	for _, key := range []string{`"kind"`, `"source"`, `"command"`, `"version"`, `"protocol"`} {
		if !strings.Contains(out.String(), key) {
			t.Fatalf("missing %s in %s", key, out.String())
		}
	}
}

func TestRuntimeCommandHuman(t *testing.T) {
	t.Setenv("PAIRFOB_DEV_FAKE_RUNTIME", "1")
	var out bytes.Buffer
	if err := writeRuntimeCommand(&out, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "fake  fake:explicit-dev") {
		t.Fatalf("output=%q", out.String())
	}
}

func TestRuntimeCommandRejectsUnknownRuntime(t *testing.T) {
	t.Setenv("PAIRFOB_DEV_FAKE_RUNTIME", "")
	t.Setenv("PAIRFOB_RUNTIME", "bogus")
	err := writeRuntimeCommand(io.Discard, nil)
	fault, ok := runtime.AsFault(err)
	if !ok || fault.Code != runtime.CodeInvalid || !strings.Contains(fault.SafeMessage, "herdr, core, or auto") {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestRuntimeCommandRejectsUnknownFlag(t *testing.T) {
	if err := writeRuntimeCommand(io.Discard, []string{"--kind"}); err == nil || !strings.Contains(err.Error(), runtimeUsage) {
		t.Fatalf("err=%v", err)
	}
}
