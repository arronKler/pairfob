package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCommandCodeCatalogAndQueuedStartup(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", home)
	binary := filepath.Join(home, "command-code")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	inputs, starts := 0, 0
	socket, _ := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
		switch req.Method {
		case "pane.send_input":
			inputs++
			return scriptedReply{Result: map[string]any{"type": "ok"}}
		case "agent.start":
			starts++
		}
		return standardReply(req)
	})
	h := NewHerdr(socket)
	h.HookBinary = "/safe/pairfob"
	descriptor, err := h.Describe(context.Background(), SessionRef{})
	if err != nil || !containsAgent(descriptor.AgentKinds, "cmd") {
		t.Fatalf("catalog: %+v %v", descriptor, err)
	}
	receipt, err := h.Execute(context.Background(), SessionRef{}, "start-command-code", CreateConversationCommand{CWD: home, AgentKind: "cmd"})
	if err != nil || receipt.Outcome != OutcomeApplied || inputs != 1 || starts != 0 {
		t.Fatalf("receipt=%+v err=%v inputs=%d starts=%d", receipt, err, inputs, starts)
	}
	for _, created := range receipt.Created {
		if created.Kind == EntityAgent {
			t.Fatal("reported an agent before native lazy binding")
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".commandcode", "mods", "pairfob-session.ts")); err != nil {
		t.Fatal(err)
	}
}
