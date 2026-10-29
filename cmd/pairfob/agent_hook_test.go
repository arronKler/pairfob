package main

import (
	"strings"
	"testing"
)

func TestAgentHookNativeEvents(t *testing.T) {
	for _, tc := range []struct {
		agent, input, id string
		clear            bool
	}{
		{"gemini", `{"session_id":"native-session-01","timestamp":"2026-10-28T12:00:00.123Z","hook_event_name":"SessionStart","source":"resume"}`, "native-session-01", false},
		{"gemini", `{"session_id":"native-session-01","timestamp":"2026-10-28T12:00:00.123Z","hook_event_name":"SessionEnd"}`, "native-session-01", true},
		{"cline", `{"taskId":"native-session-02","timestamp":"2026-10-28T12:00:00.123Z","hookName":"agent_resume","agent_id":"lead","parent_agent_id":null}`, "native-session-02", false},
		{"cline", `{"taskId":"native-session-02","timestamp":"2026-10-28T12:00:00.123Z","hookName":"session_shutdown","agent_id":"lead","parent_agent_id":null}`, "native-session-02", true},
	} {
		report, err := parseAgentHook([]string{tc.agent}, strings.NewReader(tc.input))
		if err != nil || report.SessionID != tc.id || report.Clear != tc.clear || report.Sequence != 1793188800123000000 {
			t.Fatalf("%+v: %v", report, err)
		}
	}
	for _, tc := range []struct{ agent, input string }{
		{"gemini", `{"session_id":"native-session-01","timestamp":"2026-10-28T12:00:00Z","hook_event_name":"AfterTool"}`},
		{"gemini", `{"session_id":"native-session-01","timestamp":"2026-10-28T12:00:00Z","hook_event_name":"SessionStart","source":"child"}`},
		{"gemini", `{"session_id":"native-session-01","hook_event_name":"SessionStart","source":"startup"}`},
		{"cline", `{"taskId":"native-session-01","timestamp":"2026-10-28T12:00:00Z","hookName":"agent_start","agent_id":"child","parent_agent_id":"lead"}`},
		{"cline", `{"taskId":"legacy-task","timestamp":"2026-10-28T12:00:00Z","hookName":"TaskStart"}`},
		{"gemini", strings.Repeat(" ", (1<<20)+1)},
	} {
		if _, err := parseAgentHook([]string{tc.agent}, strings.NewReader(tc.input)); err == nil {
			t.Fatalf("accepted unsupported %s hook", tc.agent)
		}
	}
}

func TestAgentHookDoesNothingOutsideHerdr(t *testing.T) {
	t.Setenv("HERDR_ENV", "")
	if err := agentHook([]string{"gemini"}, strings.NewReader("invalid")); err != nil {
		t.Fatal(err)
	}
	for _, agent := range []string{"amp", "maki"} {
		report, err := parseAgentHook([]string{agent, "native-session-01", "12345", "clear"}, nil)
		if err != nil || !report.Clear || report.Sequence != 12345 {
			t.Fatalf("%+v %v", report, err)
		}
	}
}

func TestCommandCodeHookCarriesOnlyLocalObservation(t *testing.T) {
	report, err := parseAgentHook([]string{"cmd"}, strings.NewReader(`{"session_id":"native-session-01","leaf":"prompt01","sequence":123,"activity":{"type":"tool","name":"shell","state":"error","at":1000}}`))
	if err != nil || report.Leaf == nil || *report.Leaf != "prompt01" || report.Activity == nil || report.Activity.Name != "shell" || report.Sequence != 123 {
		t.Fatalf("report: %+v %v", report, err)
	}
	if _, err := parseAgentHook([]string{"cmd"}, strings.NewReader(strings.Repeat(" ", 4097))); err == nil {
		t.Fatal("oversized event accepted")
	}
}
