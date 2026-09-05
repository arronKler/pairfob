package daemon

import (
	"context"
	"testing"
	"time"

	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func TestOperationLedgerSurvivesRestartAndBindsSessionAndIntent(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	deviceID := "dev_12345678"
	operationID := "op_AAECAwQFBgcICQoL"
	intent := runtime.RenameTabCommand{TabID: "w0:t1", Label: "one"}
	first := NewEngine(nil, nil, runtime.NewFake())
	first.Store = store
	runs := 0
	receipt, err := first.executeTrackedMutation(context.Background(), deviceID, runtime.NamedSession("alpha"), operationID, intent, func() (runtime.Receipt, error) {
		runs++
		return runtime.Receipt{Outcome: runtime.OutcomeApplied}, nil
	})
	if err != nil || receipt.OperationID != operationID || runs != 1 {
		t.Fatalf("first receipt=%+v runs=%d err=%v", receipt, runs, err)
	}

	rows, err := store.LoadOperations()
	if err != nil || len(rows) != 1 || rows[0].Status != "completed" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	second := NewEngine(nil, nil, runtime.NewFake())
	second.Store = store
	if err := second.restoreOperations(rows); err != nil {
		t.Fatal(err)
	}
	receipt, err = second.executeTrackedMutation(context.Background(), deviceID, runtime.NamedSession("alpha"), operationID, intent, func() (runtime.Receipt, error) {
		runs++
		return runtime.Receipt{Outcome: runtime.OutcomeApplied}, nil
	})
	if err != nil || receipt.Outcome != runtime.OutcomeApplied || runs != 1 {
		t.Fatalf("restored receipt=%+v runs=%d err=%v", receipt, runs, err)
	}
	for _, changed := range []struct {
		session runtime.SessionRef
		intent  any
	}{
		{runtime.NamedSession("beta"), intent},
		{runtime.NamedSession("alpha"), runtime.RenameTabCommand{TabID: "w0:t1", Label: "two"}},
	} {
		_, err := second.executeTrackedMutation(context.Background(), deviceID, changed.session, operationID, changed.intent, func() (runtime.Receipt, error) {
			runs++
			return runtime.Receipt{}, nil
		})
		fault, ok := runtime.AsFault(err)
		if !ok || fault.Code != runtime.CodeConflict || runs != 1 {
			t.Fatalf("changed intent was not rejected: fault=%+v runs=%d err=%v", fault, runs, err)
		}
	}
}

func TestRestoredPendingOperationIsNeverReplayed(t *testing.T) {
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	intent := runtime.ClosePaneCommand{PaneID: "w0:p1"}
	fingerprint, err := operationFingerprint(runtime.DefaultSession(), intent)
	if err != nil {
		t.Fatal(err)
	}
	row := state.Operation{
		DeviceID: "dev_12345678", OperationID: "op_AQECAwQFBgcICQoL", Fingerprint: fingerprint,
		Status: "pending", CreatedAt: time.Now().Unix(),
	}
	if err := store.SaveOperations([]state.Operation{row}); err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(nil, nil, runtime.NewFake())
	engine.Store = store
	if err := engine.restoreOperations([]state.Operation{row}); err != nil {
		t.Fatal(err)
	}
	runs := 0
	receipt, err := engine.executeTrackedMutation(context.Background(), row.DeviceID, runtime.DefaultSession(), row.OperationID, intent, func() (runtime.Receipt, error) {
		runs++
		return runtime.Receipt{}, nil
	})
	fault, ok := runtime.AsFault(err)
	if !ok || fault.Outcome != runtime.OutcomeUnknown || receipt.Outcome != runtime.OutcomeUnknown || runs != 0 {
		t.Fatalf("pending receipt=%+v fault=%+v runs=%d err=%v", receipt, fault, runs, err)
	}
}

func TestPaneCreationPreservesTerminalOperationFingerprints(t *testing.T) {
	ratio := 0.5
	for _, fixture := range []struct {
		command     runtime.Command
		withAgent   runtime.Command
		fingerprint string
	}{
		{
			runtime.CreateTabCommand{WorkspaceID: "w1", CWD: "/repo", Label: "test"},
			runtime.CreateTabCommand{WorkspaceID: "w1", CWD: "/repo", Label: "test", AgentKind: "codex"},
			"fed7195292bdac28bd4bf64601a1a6d4ff7244ac4e78d8a0e5a5d2cd1c4d9145",
		},
		{
			runtime.SplitPaneCommand{WorkspaceID: "w1", TargetPaneID: "w1:p1", TargetTabID: "w1:t1", CWD: "/repo", Direction: runtime.SplitRight, Ratio: &ratio},
			runtime.SplitPaneCommand{WorkspaceID: "w1", TargetPaneID: "w1:p1", TargetTabID: "w1:t1", CWD: "/repo", Direction: runtime.SplitRight, Ratio: &ratio, AgentKind: "codex"},
			"faff6da2a59ca580df61f6b1e6ccc59e9fe59a9260497c7251b4e7f05ba36a39",
		},
	} {
		// These hashes use the command JSON shape before pane type selection.
		got, err := operationFingerprint(runtime.DefaultSession(), fixture.command)
		if err != nil || got != fixture.fingerprint {
			t.Fatalf("%T changed historical terminal fingerprint: got=%s err=%v", fixture.command, got, err)
		}
		changed, err := operationFingerprint(runtime.DefaultSession(), fixture.withAgent)
		if err != nil || changed == got {
			t.Fatalf("%T agent kind must be part of the intent: %s err=%v", fixture.withAgent, changed, err)
		}
		engine := NewEngine(nil, nil, runtime.NewFake())
		row := state.Operation{DeviceID: "dev_12345678", OperationID: "op_legacycreate0001", Fingerprint: fixture.fingerprint, Status: "pending", CreatedAt: time.Now().Unix()}
		if err := engine.restoreOperations([]state.Operation{row}); err != nil {
			t.Fatal(err)
		}
		_, err = engine.executeTrackedMutation(context.Background(), row.DeviceID, runtime.DefaultSession(), row.OperationID, fixture.command, func() (runtime.Receipt, error) {
			t.Fatal("a restored terminal operation must never run again")
			return runtime.Receipt{}, nil
		})
		if fault, ok := runtime.AsFault(err); !ok || fault.Outcome != runtime.OutcomeUnknown {
			t.Fatalf("historical operation must remain unknown, not conflict: %v", err)
		}
	}
}
