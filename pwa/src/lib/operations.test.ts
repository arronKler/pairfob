import { describe, expect, test } from "bun:test";
import {
  advertisesUploadV2,
  createOperationID,
  fitOperationPrompt,
  NO_OPERATION_CAPABILITIES,
  OPERATION_INPUT_LIMITS,
  openWorktreeFromSummary,
  parseCreateConversationResult,
  parseCreateTabResult,
  parseCreateWorktreeResult,
  parseAgentTracePage,
  parseAgentTraceSummaryPage,
  parseAgentTraceDetail,
  parseHistoryPage,
  parseOpenWorktreeResult,
  parsePromptAgentResult,
  parseResizePaneResult,
  parseRuntimeOperationsConfig,
  advertisesTraceLabels,
  advertisesTraceMarkers,
  parseSplitPaneResult,
  parseSwapPaneResult,
  parseWorktrees,
  parseZoomPaneResult,
  reconcileMutationFailure,
  withOperationID,
  worktreeScope,
  type ListWorktreesInput,
  type WorktreeSummary,
} from "./operations.ts";
import { ProtocolError } from "./protocol/errors.ts";

const operationID = "op_AAECAwQFBgcICQoL";

function expectBadMessage(run: () => unknown): void {
  try {
    run();
    throw new Error("expected bad_message");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("bad_message");
  }
}

describe("operation wire helpers", () => {
  test("operation id uses exactly 12 random bytes as unpadded base64url", () => {
    const random = Uint8Array.from({ length: 12 }, (_, index) => index);
    expect(createOperationID(random)).toBe("op_AAECAwQFBgcICQoL");
    expect(() => createOperationID(new Uint8Array(11))).toThrow(RangeError);
  });

  test("adds one valid id without mutating the input", () => {
    const input = { pane_id: "w1:p1", direction: "right" as const };
    const params = withOperationID(input, "op_AAECAwQFBgcICQoL");
    expect(params).toEqual({ pane_id: "w1:p1", direction: "right", operation_id: "op_AAECAwQFBgcICQoL" });
    expect(input).toEqual({ pane_id: "w1:p1", direction: "right" });
    expect(() => withOperationID(input, "req_too_short")).toThrow(RangeError);
  });
});

describe("runtime operation config", () => {
	const config = (capabilities: Record<string, unknown>, agent_kinds: unknown[] = ["codex"]) => ({
		protocol: 1, build: "0.1.0", daemon_id: "d_test", hostname: "pairfob", runtime: "fake",
		vapid_public: "", submit_keys: ["Enter"], idle_pause_ms: 1800000,
		push_delivery: "webpush", push_enabled: false, agent_kinds, capabilities,
	});

	test("rejects any malformed or incomplete config", () => {
		expect(() => parseRuntimeOperationsConfig(null)).toThrow();
		expect(() => parseRuntimeOperationsConfig({ capabilities: NO_OPERATION_CAPABILITIES, agent_kinds: [] })).toThrow();
		expect(() => parseRuntimeOperationsConfig(config(
			{ create_conversation: true, history: "yes", layout: true, worktrees: true },
			["codex", "BadKind"],
		))).toThrow();
		expect(() => parseRuntimeOperationsConfig({ ...config(NO_OPERATION_CAPABILITIES), extra: true })).toThrow();
	});

  test("old daemon omits file capabilities, malformed extensions fail closed", () => {
    const { rename_file, delete_file, upload_file, upload_file_v2, ...legacy } = NO_OPERATION_CAPABILITIES;
    expect(parseRuntimeOperationsConfig(config(legacy)).capabilities).toEqual(NO_OPERATION_CAPABILITIES);
    expect(() => parseRuntimeOperationsConfig(config({ ...legacy, rename_file: "true" }))).toThrow();
    expect(() => parseRuntimeOperationsConfig(config({ ...legacy, file_actions: true }))).toThrow();
    expect(() => parseRuntimeOperationsConfig(config({ ...legacy, upload_file: 1 }))).toThrow();
    expect(() => parseRuntimeOperationsConfig(config({ ...legacy, upload_file_v2: "yes" }))).toThrow();
  });

  test("upload_file_v2 is optional (absent=false) and independent of upload_file", () => {
    const { upload_file_v2, ...rest } = NO_OPERATION_CAPABILITIES;
    // Absent upload_file_v2 stays false even when upload_file is true.
    expect(parseRuntimeOperationsConfig(config({ ...rest, upload_file: true })).capabilities).toEqual({
      ...NO_OPERATION_CAPABILITIES,
      upload_file: true,
    });
    // Advertised upload_file_v2 is recognized alongside upload_file.
    expect(parseRuntimeOperationsConfig(config({ ...rest, upload_file: true, upload_file_v2: true })).capabilities).toEqual({
      ...NO_OPERATION_CAPABILITIES,
      upload_file: true,
      upload_file_v2: true,
    });
  });

  test("trace_markers is optional for daemons that predate trace markers", () => {
    const { trace_markers, ...older } = NO_OPERATION_CAPABILITIES;
    expect(parseRuntimeOperationsConfig(config(older)).capabilities.trace_markers).toBeFalse();
    expect(parseRuntimeOperationsConfig(config({ ...older, trace_markers: true })).capabilities.trace_markers).toBeTrue();
    expect(() => parseRuntimeOperationsConfig(config({ ...older, trace_markers: "yes" }))).toThrow();
    expect(advertisesTraceMarkers({ capabilities: { trace_markers: true } })).toBeTrue();
    expect(advertisesTraceMarkers({ capabilities: { trace_markers: 1 } })).toBeFalse();
    expect(advertisesTraceMarkers(null)).toBeFalse();
    expect(advertisesTraceLabels({ capabilities: { trace_labels: true } })).toBeTrue();
    expect(advertisesTraceLabels({ capabilities: { trace_markers: true } })).toBeFalse();
  });

  test("list_sessions is optional, accepts only booleans and remains available offline", () => {
    const legacy: Record<string, unknown> = { ...NO_OPERATION_CAPABILITIES };
    delete legacy.list_sessions;
    expect(parseRuntimeOperationsConfig(config(legacy)).capabilities.list_sessions).toBe(false);
    expect(parseRuntimeOperationsConfig({ ...config({ ...legacy, list_sessions: true }), runtime: "offline" })
      .capabilities.list_sessions).toBe(true);
    for (const invalid of ["true", 1, null]) {
      expect(() => parseRuntimeOperationsConfig(config({ ...legacy, list_sessions: invalid }))).toThrow();
    }
  });

  test("recognizes every advertised capability", () => {
    const all = Object.fromEntries(Object.keys(NO_OPERATION_CAPABILITIES).map((key) => [key, true]));
		expect(parseRuntimeOperationsConfig(config(all))).toEqual({
      capabilities: all,
      agentKinds: ["codex"],
    });
  });
});

describe("upload_file_v2 advertisement", () => {
  test("learns only from a successful GetConfig capabilities.upload_file_v2===true", () => {
    const cap = (upload_file_v2: unknown) => ({ capabilities: { upload_file_v2 } });
    expect(advertisesUploadV2(cap(true))).toBe(true);
    expect(advertisesUploadV2(cap(false))).toBe(false);
    expect(advertisesUploadV2(cap(undefined))).toBe(false);
    expect(advertisesUploadV2(cap(1))).toBe(false);
    expect(advertisesUploadV2(cap("true"))).toBe(false);
    // Missing capabilities object, or non-record config, never advertises V2.
    expect(advertisesUploadV2({})).toBe(false);
    expect(advertisesUploadV2({ capabilities: null })).toBe(false);
    expect(advertisesUploadV2({ capabilities: "yes" })).toBe(false);
    expect(advertisesUploadV2(null)).toBe(false);
    expect(advertisesUploadV2([])).toBe(false);
  });
});

describe("mutation success contracts", () => {
  test("accepts every complete new mutation result", () => {
    expect(parseCreateConversationResult({
      operation_id: operationID, workspace_id: "w.1", tab_id: "t:1", pane_id: "p_1",
      agent_kind: "claude-code", outcome: "applied",
    }).pane_id).toBe("p_1");
    expect(parseCreateConversationResult({
      operation_id: operationID, workspace_id: "w.1", tab_id: "t:1", pane_id: "p_1",
      outcome: "applied",
    }).agent_kind).toBeUndefined();

    const pane = { operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", outcome: "applied" };
    expect(parseCreateTabResult(pane).outcome).toBe("applied");
    expect(parseSplitPaneResult(pane).workspace_id).toBe("w1");
    expect(parsePromptAgentResult({ operation_id: operationID, pane_id: "p1", agent_status: "working", outcome: "applied" }).agent_status).toBe("working");

    const createdWorktree = { operation_id: operationID, workspace_id: "w1", path: "/repo/tree", branch: null, tab_id: "t1", pane_id: "p1", outcome: "applied" };
    expect(parseCreateWorktreeResult(createdWorktree).path).toBe("/repo/tree");
    expect(parseOpenWorktreeResult({ operation_id: operationID, workspace_id: "w1", path: "/repo/tree", branch: null, outcome: "noop" }).tab_id).toBeUndefined();

    const layout = { operation_id: operationID, pane_id: "p1", outcome: "applied" };
    expect(parseResizePaneResult(layout).pane_id).toBe("p1");
    expect(parseSwapPaneResult(layout).pane_id).toBe("p1");
    expect(parseZoomPaneResult({ ...layout, outcome: "noop" }).pane_id).toBe("p1");
  });

  test("fails closed before UI success on missing fields and illegal outcomes", () => {
    expectBadMessage(() => parseCreateConversationResult({
      operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent_kind: "codex", outcome: "noop",
    }));
    expectBadMessage(() => parseCreateConversationResult({
      operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent_kind: "codex", outcome: "applied",
    }, "op_b123456789abcdef"));
    expectBadMessage(() => parseCreateConversationResult({
      operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent_kind: "", outcome: "applied",
    }));
    expectBadMessage(() => parseCreateTabResult({ operation_id: operationID, workspace_id: "w1", tab_id: "t1", outcome: "applied" }));
    expectBadMessage(() => parseCreateTabResult({ operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", outcome: "noop" }));
    const completePane = { operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", outcome: "applied" };
    expectBadMessage(() => parseCreateTabResult({ ...completePane, agent_kind: "codex" }));
    expectBadMessage(() => parseSplitPaneResult({ ...completePane, agent_kind: "claude" }));
    expectBadMessage(() => parseSplitPaneResult({ operation_id: "bad", workspace_id: "w1", tab_id: "t1", pane_id: "p1", outcome: "applied" }));
    expectBadMessage(() => parseSplitPaneResult({ ...{
      operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", outcome: "applied",
    }, extra: true }));
    expectBadMessage(() => parsePromptAgentResult({ operation_id: operationID, pane_id: "p1", agent_status: "mystery", outcome: "applied" }));
    expectBadMessage(() => parsePromptAgentResult({ operation_id: operationID, pane_id: "p1", agent_status: "working", outcome: "noop" }));
    expectBadMessage(() => parseCreateWorktreeResult({ operation_id: operationID, workspace_id: "w1", outcome: "applied" }));
    expectBadMessage(() => parseCreateWorktreeResult({
      operation_id: operationID, workspace_id: "w1", tab_id: "t1", pane_id: "p1", path: "/x", branch: null, outcome: "noop",
    }));
    expectBadMessage(() => parseOpenWorktreeResult({ operation_id: operationID, workspace_id: "w1", path: "/x", branch: null, outcome: "unknown" }));
    expectBadMessage(() => parseResizePaneResult({ operation_id: operationID, pane_id: "p1", outcome: "partial_failure" }));
    expectBadMessage(() => parseSwapPaneResult({ operation_id: operationID, outcome: "applied" }));
    expectBadMessage(() => parseZoomPaneResult(null));
  });

  test("publishes the limits consumed by config parsing and operation forms", () => {
    expect(OPERATION_INPUT_LIMITS).toEqual({ cwd: 4096, path: 4096, label: 256, branch: 512, base: 512, prompt: 32768, agentKind: 32 });
    expect(fitOperationPrompt("a".repeat(32_768))).toEqual({ text: "a".repeat(32_768), truncated: false });
    const cjk = fitOperationPrompt("会".repeat(32_768));
    expect(cjk.truncated).toBeTrue();
    expect(new TextEncoder().encode(cjk.text).length).toBeLessThanOrEqual(32_768);
  });

  test("reconciles ambiguous failures with reads only and preserves the original error", async () => {
    for (const code of ["unknown_outcome", "partial_failure", "bad_message"]) {
      const calls: string[] = [];
      const original = new ProtocolError(code, "original");
      expect(await reconcileMutationFailure(original, {
        snapshot: async () => { calls.push("Snapshot"); },
        listWorktrees: async () => { calls.push("ListWorktrees"); },
      })).toBeTrue();
      expect(calls).toEqual(["Snapshot", "ListWorktrees"]);
      expect(original.code).toBe(code);
      expect(original.message).toBe("original");
    }
    const calls: string[] = [];
    expect(await reconcileMutationFailure(new ProtocolError("unsupported"), {
      snapshot: async () => { calls.push("Snapshot"); },
    })).toBeFalse();
    expect(calls).toEqual([]);
  });
});

describe("safe read normalization", () => {
  test("accepts only the frozen items and next_cursor history envelope", () => {
    expect(parseHistoryPage({
      items: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }],
      next_cursor: "page-2",
      truncated: false,
    })).toEqual({
      items: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }],
      nextCursor: "page-2",
      truncated: false,
    });
    expectBadMessage(() => parseHistoryPage({ messages: ["old shape"], next_cursor: null, truncated: false }));
    expectBadMessage(() => parseHistoryPage({ items: [{ role: "system", text: "not rendered" }], next_cursor: null, truncated: false }));
    expectBadMessage(() => parseHistoryPage({ items: [], next_cursor: null, truncated: "no" }));
    expectBadMessage(() => parseHistoryPage({ items: [], cursor: "old-cursor", truncated: false }));
  });

  test("accepts the AgentTrace envelope and rejects extra fields", () => {
    expect(parseAgentTracePage({
      items: [
        { type: "user", text: "hello" },
        { type: "thinking", text: "plan" },
        { type: "tool", name: "Read", input: "{\"path\":\"a\"}", output: "ok" },
        { type: "assistant", text: "done" },
      ],
      next_cursor: null,
      truncated: false,
    })).toEqual({
      items: [
        { type: "user", text: "hello" },
        { type: "thinking", text: "plan" },
        { type: "tool", name: "Read", input: "{\"path\":\"a\"}", output: "ok" },
        { type: "assistant", text: "done" },
      ],
      nextCursor: null,
      truncated: false,
    });
    expectBadMessage(() => parseAgentTracePage({ items: [{ type: "tool" }], next_cursor: null, truncated: false }));
    expectBadMessage(() => parseAgentTracePage({ items: [{ type: "system", text: "no" }], next_cursor: null, truncated: false }));
    expectBadMessage(() => parseAgentTracePage({ items: [{ type: "user", text: "x", extra: true }], next_cursor: null, truncated: false }));
  });

  test("accepts opt-in command and textless marker items in both trace shapes", () => {
    const items = [
      { type: "command", text: "/clear" },
      { type: "interrupt" },
      { type: "compaction" },
    ];
    for (const parse of [parseAgentTracePage, parseAgentTraceSummaryPage]) {
      expect(parse({ items, next_cursor: null, truncated: false }).items).toEqual(items);
      expectBadMessage(() => parse({ items: [{ type: "command" }], next_cursor: null, truncated: false }));
      expectBadMessage(() => parse({ items: [{ type: "interrupt", text: "injected" }], next_cursor: null, truncated: false }));
    }
  });

  test("a summary tool may carry a one-line label of at most 160 characters", () => {
    const base = { type: "tool", name: "Read", state: "done", detail_ref: "d1" };
    expect(parseAgentTraceSummaryPage({ items: [{ ...base, label: "src/a.ts" }], next_cursor: null, truncated: false }).items)
      .toEqual([{ type: "tool", name: "Read", toolState: "done", detailRef: "d1", label: "src/a.ts" }]);
    expectBadMessage(() => parseAgentTraceSummaryPage({ items: [{ ...base, label: "x".repeat(161) }], next_cursor: null, truncated: false }));
    expectBadMessage(() => parseAgentTraceSummaryPage({ items: [{ ...base, label: "" }], next_cursor: null, truncated: false }));
  });

  test("summary items may carry a non-negative integer record time", () => {
    const page = parseAgentTraceSummaryPage({ items: [
      { type: "user", text: "go", at: 1791023688977 },
      { type: "tool", name: "Read", state: "done", detail_ref: "d1", at: 1791023718674 },
      { type: "compaction", at: 1791023735252 },
    ], next_cursor: null, truncated: false });
    expect(page.items.map((item) => item.at)).toEqual([1791023688977, 1791023718674, 1791023735252]);
    for (const at of [-1, 1.5, "1791023688977"]) {
      expectBadMessage(() => parseAgentTraceSummaryPage({ items: [{ type: "user", text: "go", at }], next_cursor: null, truncated: false }));
    }
  });

  test("a timed summary page carries the computer's clock", () => {
    expect(parseAgentTraceSummaryPage({ items: [], next_cursor: null, truncated: false, now: 1791023688977 }).now).toBe(1791023688977);
    expect(parseAgentTraceSummaryPage({ items: [], next_cursor: null, truncated: false }).now).toBeUndefined();
    expectBadMessage(() => parseAgentTraceSummaryPage({ items: [], next_cursor: null, truncated: false, now: "soon" }));
  });

  test("keeps AgentTraceSummary tool bodies off the wire and binds detail replies", () => {
    expect(parseAgentTraceSummaryPage({
      items: [
        { type: "user", text: "hello" },
        { type: "tool", name: "Read", state: "done", detail_ref: "detail-1" },
      ],
      next_cursor: "older",
      truncated: false,
    })).toEqual({
      items: [
        { type: "user", text: "hello" },
        { type: "tool", name: "Read", toolState: "done", detailRef: "detail-1" },
      ],
      nextCursor: "older",
      truncated: false,
    });
    expect(parseAgentTraceDetail({
      detail_ref: "detail-1", input: '{"path":"a.ts"}', output: "ok", truncated: true,
    }, "detail-1")).toEqual({
      detailRef: "detail-1", input: '{"path":"a.ts"}', output: "ok", truncated: true,
    });
    expectBadMessage(() => parseAgentTraceSummaryPage({
      items: [{ type: "tool", name: "Read", state: "done", detail_ref: "detail-1", input: "leak" }],
      next_cursor: null,
      truncated: false,
    }));
    expectBadMessage(() => parseAgentTraceDetail({ detail_ref: "other", truncated: false }, "detail-1"));
  });

  test("validates the exact worktree result while keeping display fields", () => {
    expect(parseWorktrees({ worktrees: [
      {
        path: "/repo/a", branch: "feature/a", label: null,
        is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true,
        open_workspace_id: "w1",
      },
    ] })).toEqual([{ path: "/repo/a", branch: "feature/a", openWorkspaceId: "w1" }]);
    expectBadMessage(() => parseWorktrees({ worktrees: [{ path: "/repo/a" }] }));
    expectBadMessage(() => parseWorktrees({ worktrees: [{
      path: "/repo/a", branch: null, label: null,
      is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: "yes",
      open_workspace_id: null,
    }] }));
    expectBadMessage(() => parseWorktrees({ worktrees: [], extra: true }));
  });

  test("uses one workspace selector and one open target", () => {
    const scope = worktreeScope("w1", "/ignored/cwd");
    const typedScope: ListWorktreesInput = { workspace_id: "w1" };
    expect(scope).toEqual({ workspace_id: "w1" });
    expect(typedScope).toEqual(scope);
    expect(worktreeScope("", "")).toBeNull();
    expect(openWorktreeFromSummary(scope!, { branch: "fallback", path: "/repo/tree" })).toEqual({
      workspace_id: "w1",
      path: "/repo/tree",
    });
    expect(openWorktreeFromSummary(scope!, {} as WorktreeSummary)).toBeNull();
  });
});
