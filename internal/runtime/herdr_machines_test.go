package runtime

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
)

// Captured from `herdr machine list --json` (Herdr 0.9.0 client, 0.9.3 remote).
const machineListSample = `[
  {
    "id": "b492e53d04afc5b0c9e552a6d886bc2b",
    "label": "Build machine",
    "target": "ssh://dev@127.0.0.1:2222",
    "session": "default",
    "enabled": true,
    "selected": false
  },
  {"id": "0f0e", "label": "off", "target": "workbox", "session": "agents", "enabled": false, "selected": false},
  {"id": "dash", "label": "option", "target": "-oProxyCommand=evil", "session": "default", "enabled": true},
  {"id": "space", "label": "split", "target": "host; rm -rf ~", "session": "default", "enabled": true},
  {"id": "bad id", "label": "id", "target": "host", "session": "default", "enabled": true}
]`

func machineHerdr(run func(context.Context, string, ...string) ([]byte, error)) *Herdr {
	h := NewHerdr("/nonexistent/herdr.sock")
	h.lookupBinary = func(string) (string, error) { return "/opt/herdr", nil }
	h.runCLI = run
	return h
}

func TestHerdrListsSavedMachinesAndDropsUnsafeTargets(t *testing.T) {
	var got []string
	h := machineHerdr(func(_ context.Context, binary string, args ...string) ([]byte, error) {
		got = append([]string{binary}, args...)
		return []byte(machineListSample), nil
	})
	view, err := h.Observe(context.Background(), DefaultSession(), MachineListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"/opt/herdr", "machine", "list", "--json"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	want := []Machine{
		{ID: "b492e53d04afc5b0c9e552a6d886bc2b", Label: "Build machine", Target: "ssh://dev@127.0.0.1:2222", Session: "default", Enabled: true},
		{ID: "0f0e", Label: "off", Target: "workbox", Session: "agents"},
	}
	if machines := view.(MachineListView).Machines; !reflect.DeepEqual(machines, want) {
		t.Fatalf("machines = %+v, want %+v", machines, want)
	}
}

func TestHerdrMachineListFailsClosed(t *testing.T) {
	cases := map[string]struct {
		out  string
		err  error
		code ErrorCode
	}{
		"older herdr without the command": {err: &exec.ExitError{}, code: CodeUnsupported},
		"cli cannot start":                {err: errors.New("fork failed"), code: CodeOffline},
		"unreadable output":               {out: "No saved SSH machines.", code: CodeInternal},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := machineHerdr(func(context.Context, string, ...string) ([]byte, error) { return []byte(tc.out), tc.err })
			_, err := h.Observe(context.Background(), DefaultSession(), MachineListQuery{})
			var fault *Fault
			if !errors.As(err, &fault) || fault.Code != tc.code {
				t.Fatalf("err = %v, want fault %s", err, tc.code)
			}
		})
	}
}

func TestHerdrMachineListWithoutCLIIsUnsupported(t *testing.T) {
	h := machineHerdr(nil)
	h.lookupBinary = func(string) (string, error) { return "", errHerdrNotFound }
	_, err := h.Observe(context.Background(), DefaultSession(), MachineListQuery{})
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != CodeUnsupported {
		t.Fatalf("err = %v, want unsupported", err)
	}
}
