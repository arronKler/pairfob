import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { ProtocolError } from "./lib/protocol/errors.ts";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "sessionStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
happy.document.body.innerHTML = '<main id="app"></main>';

const { messageOf, state } = await import("./state.ts");
const { readStoredDraft } = await import("./state-drafts.ts");
const {
  acquirePromptLock,
  applyComposeDraft,
  bumpViewGeneration,
  captureComposeDraft,
  capturePromptRequest,
  clearCurrentComposeDraft,
  currentComposeDraftScope,
  currentViewGeneration,
  promptRequestIsLive,
  recoverComposeDraft,
  releasePromptLock,
  resetComposeDrafts,
  settlePromptFailure,
  settlePromptSuccess,
  switchComposeView,
} = await import("./compose-drafts.ts");

const sessionA = { id: "a" };
const sessionB = { id: "b" };

function credential(daemonId: string) {
  return {
    daemonId,
    deviceId: `phone_${daemonId}`,
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com",
    fp: `fp_${daemonId}`,
    label: "test",
    createdAt: 1,
  };
}

function boot(opts?: { paneId?: string; daemonId?: string; session?: object; mode?: "agent" | "guided" | "full" }) {
  const mode = opts?.mode ?? "agent";
  state.phase = "live";
  state.screen = "pane";
  state.paneId = opts?.paneId ?? "p1";
  state.credential = credential(opts?.daemonId ?? "daemon-a");
  state.live = (opts?.session ?? sessionA) as typeof state.live;
  state.agentChat = mode === "agent";
  state.fullTerminal = mode === "full";
  state.composeDraft = "";
  state.agentTraceNote = "";
  state.operationBusy = false;
  state.notice = null;
}

afterEach(() => {
  resetComposeDrafts();
  state.operationBusy = false;
  state.composeDraft = "";
  state.agentTraceNote = "";
  state.live = null;
  state.credential = null;
  state.notice = null;
});

describe("compose drafts stay on their pane and mode", () => {
  test("navigation roundtrip restores the parked draft", () => {
    boot();
    state.composeDraft = "pane A chat";
    captureComposeDraft();
    switchComposeView(() => {
      state.paneId = "p2";
    });
    expect(state.composeDraft).toBe("");
    state.composeDraft = "pane B chat";
    switchComposeView(() => {
      state.paneId = "p1";
    });
    expect(state.composeDraft).toBe("pane A chat");
    switchComposeView(() => {
      state.paneId = "p2";
    });
    expect(state.composeDraft).toBe("pane B chat");
  });

  test("control, chat, and full-terminal drafts on one pane do not overwrite each other", () => {
    boot({ mode: "guided" });
    state.composeDraft = "guided text";
    switchComposeView(() => {
      state.agentChat = true;
    });
    expect(state.composeDraft).toBe("");
    state.composeDraft = "chat text";
    switchComposeView(() => {
      state.agentChat = false;
      state.fullTerminal = true;
    });
    expect(state.composeDraft).toBe("");
    state.composeDraft = "full text";
    switchComposeView(() => {
      state.fullTerminal = false;
      state.agentChat = true;
    });
    expect(state.composeDraft).toBe("chat text");
    switchComposeView(() => {
      state.agentChat = false;
    });
    expect(state.composeDraft).toBe("guided text");
    switchComposeView(() => {
      state.fullTerminal = true;
    });
    expect(state.composeDraft).toBe("full text");
  });

  test("does not write prompt drafts to localStorage", () => {
    boot();
    localStorage.clear();
    state.composeDraft = "secret prompt never persisted";
    captureComposeDraft();
    expect(localStorage.length).toBe(0);
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.key(i)).not.toContain("draft");
    }
  });
});

describe("prompt request ownership", () => {
  test("a late failure restores the original scope and skips a newer edit", () => {
    boot();
    state.composeDraft = "send me";
    const owner = capturePromptRequest(sessionA, "p1", "send me")!;
    clearCurrentComposeDraft();
    expect(promptRequestIsLive(owner)).toBe(true);
    const timeout = new ProtocolError("timeout", "A timed out");
    settlePromptFailure(owner, timeout);
    expect(state.composeDraft).toBe("send me");
    expect(readStoredDraft(owner.draftScope).error).toBe(messageOf(timeout));

    state.composeDraft = "newer edit";
    const skipped = recoverComposeDraft(owner.draftScope, "send me");
    expect(skipped).toBe(false);
    expect(state.composeDraft).toBe("newer edit");
  });

  test("unknown_outcome records the error and does not put the prompt back", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "maybe sent")!;
    clearCurrentComposeDraft();
    const unknown = new ProtocolError("unknown_outcome", "refresh first");
    const result = settlePromptFailure(owner, unknown);
    expect(result.unknownOutcome).toBe(true);
    expect(state.composeDraft).toBe("");
    expect(readStoredDraft(owner.draftScope).text).toBe("");
    expect(readStoredDraft(owner.draftScope).error).toBe(messageOf(unknown));
  });

  test("leaving the pane, switching computers, or a new generation is not live", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "owned")!;
    state.paneId = "p2";
    expect(promptRequestIsLive(owner)).toBe(false);

    boot();
    expect(promptRequestIsLive(owner)).toBe(true);
    switchComposeView(() => {
      state.agentChat = false;
    });
    expect(promptRequestIsLive(owner)).toBe(false);

    boot();
    state.credential = credential("daemon-b");
    state.live = sessionB as typeof state.live;
    expect(promptRequestIsLive(owner)).toBe(false);

    boot();
    bumpViewGeneration();
    expect(promptRequestIsLive(owner)).toBe(false);
    expect(currentViewGeneration()).toBeGreaterThan(owner.viewGeneration);
  });

  test("a later lock survives the original request finishing", () => {
    boot();
    const first = capturePromptRequest(sessionA, "p1", "first")!;
    bumpViewGeneration();
    state.operationBusy = false;
    const second = acquirePromptLock();
    expect(second).not.toBeNull();
    expect(releasePromptLock(first.lockId)).toBe(false);
    expect(state.operationBusy).toBe(true);
    expect(releasePromptLock(second!)).toBe(true);
    expect(state.operationBusy).toBe(false);
  });

  test("success on a stale view does not clobber a newer draft for that scope", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "first send")!;
    clearCurrentComposeDraft();
    bumpViewGeneration();
    state.live = sessionB as typeof state.live;
    boot({ session: sessionB });
    state.composeDraft = "typed after reconnect";
    captureComposeDraft();
    settlePromptSuccess(owner);
    expect(state.composeDraft).toBe("typed after reconnect");
    expect(readStoredDraft(currentComposeDraftScope()!).text).toBe("typed after reconnect");
  });

  test("apply restores a parked failure note only on agent chat", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "failed send")!;
    clearCurrentComposeDraft();
    state.paneId = "p2";
    const failed = new ProtocolError("timeout", "A failed");
    settlePromptFailure(owner, failed);
    expect(state.composeDraft).toBe("");
    expect(state.agentTraceNote).toBe("");
    switchComposeView(() => {
      state.paneId = "p1";
    });
    expect(state.composeDraft).toBe("failed send");
    expect(state.agentTraceNote).toBe(messageOf(failed));
  });
});
