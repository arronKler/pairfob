import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProtocolError } from "../../../lib/protocol/errors";
import { messageOf } from "../../../lib/notices";
import { setOperationBusy, operationBusy } from "../../operations/capabilities-store";
import { applyTrace, chatSnapshot, setTraceNote } from "../chat/trace-store";
import {
  composeDraft, composeIME, composeStore, setComposeDraft, setComposeIME,
} from "../compose-store";
import {
  attachLiveSession, credential, lastUsedDaemon, liveSession, setCredential, setLastUsedDaemon,
} from "../../computers/catalog-store";
import { phase, setPhase, type Phase } from "../../connection/connection-store";
import { currentScreen, setScreen, type Screen } from "../../../app/navigation-store";
import {
  isAgentChat, isFullTerminal, openPaneId, selectPane, setAgentChat, setFullTerminal,
} from "../session-store";
import { clearNotice, noticesStore, showError, showStatus, type Notice } from "../../../app/notices-store";
import {
  acquirePromptLock,
  adoptScreen,
  applyComposeDraft,
  bumpViewIncarnation,
  captureComposeDraft,
  capturePromptRequest,
  currentComposeDraftScope,
  currentViewIncarnation,
  promptRequestIsLive,
  promptRequestOwnsComputer,
  recoverComposeDraft,
  releasePromptLock,
  resetComposeDrafts,
  settlePromptFailure,
  settlePromptSuccess,
  switchComposeView,
} from "./compose-drafts";
import {
  nextDraftRevision, parkStoredDraft, readStoredDraft, storedDraftIsParked, writeStoredDraft,
} from "./state-drafts";
import type { PairResult, LiveSession } from "../../../lib/protocol/client";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "sessionStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
happy.document.body.innerHTML = '<main id="app"></main>';

const sessionA = { id: "a" };
const sessionB = { id: "b" };

function pair(daemonId: string): PairResult {
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

/**
 * Foreign preimages of every field this fixture seeds (and the typed side
 * effects those seeds leave — setCredential rewrites lastUsedDaemonId — plus
 * the raw localStorage the tests clear), captured before each case so afterEach
 * restores the exact pre-case baseline through named owner actions. Only the
 * fields this suite writes are restored; other owner fields are never touched
 * and no store.reset / facade / injection is used.
 */
const checkpoint = {
  phase: "boot" as Phase,
  screen: "home" as Screen,
  paneId: "",
  agentChat: false,
  fullTerminal: false,
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  live: null as unknown as LiveSession | null,
  composeDraft: "",
  composeIME: false,
  agentTraceNote: "",
  operationBusy: false,
  notice: null as Notice | null,
};
let storagePreimage: [string, string][] = [];

function boot(opts?: { paneId?: string; daemonId?: string; session?: object; mode?: "agent" | "guided" | "full" }) {
  const mode = opts?.mode ?? "agent";
  setPhase("live");
  setScreen("pane");
  selectPane(opts?.paneId ?? "p1");
  setCredential(pair(opts?.daemonId ?? "daemon-a"));
  attachLiveSession((opts?.session ?? sessionA) as unknown as LiveSession);
  setAgentChat(mode === "agent");
  setFullTerminal(mode === "full");
  setComposeDraft("");
  setTraceNote("");
  setOperationBusy(false);
  clearNotice();
}

beforeEach(() => {
  checkpoint.phase = phase();
  checkpoint.screen = currentScreen();
  checkpoint.paneId = openPaneId();
  checkpoint.agentChat = isAgentChat();
  checkpoint.fullTerminal = isFullTerminal();
  checkpoint.credential = credential();
  checkpoint.lastUsed = lastUsedDaemon();
  checkpoint.live = liveSession();
  checkpoint.composeDraft = composeDraft();
  checkpoint.composeIME = composeIME();
  checkpoint.agentTraceNote = chatSnapshot().agentTraceNote;
  checkpoint.operationBusy = operationBusy();
  checkpoint.notice = noticesStore.get().notice;
  const rawKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) rawKeys.push(localStorage.key(i)!);
  storagePreimage = rawKeys.map((key) => [key, localStorage.getItem(key)!] as [string, string]);
});

afterEach(() => {
  resetComposeDrafts();
  setPhase(checkpoint.phase);
  setScreen(checkpoint.screen);
  selectPane(checkpoint.paneId);
  setAgentChat(checkpoint.agentChat);
  setFullTerminal(checkpoint.fullTerminal);
  setCredential(checkpoint.credential);
  setLastUsedDaemon(checkpoint.lastUsed);
  attachLiveSession(checkpoint.live);
  setComposeDraft(checkpoint.composeDraft);
  setComposeIME(checkpoint.composeIME);
  setTraceNote(checkpoint.agentTraceNote);
  setOperationBusy(checkpoint.operationBusy);
  if (checkpoint.notice) {
    if (checkpoint.notice.tone === "error") showError(checkpoint.notice.text, checkpoint.notice.scope, true);
    else showStatus(checkpoint.notice.text, true, checkpoint.notice.scope);
  } else {
    clearNotice();
  }
  // Exact raw storage restoration last: put every captured key back after the
  // named restores so a setter's own persistence cannot clobber the preimage.
  localStorage.clear();
  for (const [key, value] of storagePreimage) localStorage.setItem(key, value);
});

describe("compose drafts stay on their pane and mode", () => {
  test("navigation roundtrip restores the parked draft", () => {
    boot();
    setComposeDraft("pane A chat");
    captureComposeDraft();
    switchComposeView(() => {
      selectPane("p2");
    });
    expect(composeDraft()).toBe("");
    setComposeDraft("pane B chat");
    switchComposeView(() => {
      selectPane("p1");
    });
    expect(composeDraft()).toBe("pane A chat");
    switchComposeView(() => {
      selectPane("p2");
    });
    expect(composeDraft()).toBe("pane B chat");
  });

  test("control, chat, and full-terminal drafts on one pane do not overwrite each other", () => {
    boot({ mode: "guided" });
    setComposeDraft("guided text");
    switchComposeView(() => {
      setAgentChat(true);
    });
    expect(composeDraft()).toBe("");
    setComposeDraft("chat text");
    switchComposeView(() => {
      setAgentChat(false);
      setFullTerminal(true);
    });
    expect(composeDraft()).toBe("");
    setComposeDraft("full text");
    switchComposeView(() => {
      setFullTerminal(false);
      setAgentChat(true);
    });
    expect(composeDraft()).toBe("chat text");
    switchComposeView(() => {
      setAgentChat(false);
    });
    expect(composeDraft()).toBe("guided text");
    switchComposeView(() => {
      setFullTerminal(true);
    });
    expect(composeDraft()).toBe("full text");
  });

  test("does not write prompt drafts to localStorage", () => {
    boot();
    localStorage.clear();
    setComposeDraft("secret prompt never persisted");
    captureComposeDraft();
    expect(localStorage.length).toBe(0);
  });

  test("leaving the pane screen parks the draft before losing its scope", () => {
    boot();
    setComposeDraft("typed on pane");
    adoptScreen("settings");
    expect(currentScreen()).toBe("settings");
    expect(currentComposeDraftScope()).toBeNull();
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("typed on pane");
    captureComposeDraft();
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("typed on pane");
  });

  test("clearing the home view cannot overwrite a parked guided draft", () => {
    boot({ mode: "guided" });
    setComposeDraft("guided home roundtrip");
    adoptScreen("home");
    setComposeDraft("");
    captureComposeDraft();
    adoptScreen("pane");
    expect(composeDraft()).toBe("guided home roundtrip");
  });

  test("a retired live field's parked text survives an empty replacement capture", () => {
    boot({ mode: "guided" });
    // A same-pane view replacement leaves the new field empty.
    switchComposeView(() => {});
    const scope = currentComposeDraftScope()!;
    writeStoredDraft(scope, { text: "private A IME", revision: nextDraftRevision() });
    parkStoredDraft(scope);
    // The replacement's empty draft must not erase the parked text.
    captureComposeDraft();
    expect(readStoredDraft(scope).text).toBe("private A IME");
    expect(storedDraftIsParked(scope)).toBe(true);
    // A real leave/return restores it exactly once as an ordinary draft.
    switchComposeView(() => {
      selectPane("p2");
    });
    switchComposeView(() => {
      selectPane("p1");
    });
    expect(composeDraft()).toBe("private A IME");
    expect(storedDraftIsParked(scope)).toBe(false);
    // After it became visible, a deliberate clear sticks.
    setComposeDraft("");
    captureComposeDraft();
    expect(readStoredDraft(scope).text).toBe("");
  });

  test("an older apply cannot clear a newer parked transfer created by its publication", () => {
    boot({ mode: "guided" });
    switchComposeView(() => {});
    const scope = currentComposeDraftScope()!;
    writeStoredDraft(scope, { text: "old parked", revision: nextDraftRevision() });
    parkStoredDraft(scope);
    let replaced = false;
    const stop = composeStore.subscribe(() => {
      if (replaced || composeStore.get().composeDraft !== "old parked") return;
      replaced = true;
      // A newer same-scope transfer parks during the older apply's publication;
      // its replacement field stays empty.
      writeStoredDraft(scope, { text: "new parked", revision: nextDraftRevision() });
      parkStoredDraft(scope);
      setComposeDraft("");
    });
    try {
      applyComposeDraft();
    } finally {
      stop();
    }
    expect(replaced).toBe(true);
    expect(storedDraftIsParked(scope)).toBe(true);
    captureComposeDraft();
    expect(readStoredDraft(scope).text).toBe("new parked");
  });
});

describe("prompt request ownership", () => {
  test("a late failure restores the original scope and skips a newer edit", () => {
    boot();
    setComposeDraft("send me");
    const owner = capturePromptRequest(sessionA, "p1", "send me")!;
    setComposeDraft("");
    expect(promptRequestIsLive(owner)).toBe(true);
    const timeout = new ProtocolError("timeout", "A timed out");
    settlePromptFailure(owner, timeout);
    expect(composeDraft()).toBe("send me");
    expect(readStoredDraft(owner.draftScope).error).toBe(messageOf(timeout));

    setComposeDraft("newer edit");
    const skipped = recoverComposeDraft(owner.draftScope, "send me", owner.revision);
    expect(skipped).toBe(false);
    expect(composeDraft()).toBe("newer edit");
  });

  test("unknown_outcome records the error and does not put the prompt back", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "maybe sent")!;
    setComposeDraft("");
    const unknown = new ProtocolError("unknown_outcome", "refresh first");
    const result = settlePromptFailure(owner, unknown);
    expect(result.unknownOutcome).toBe(true);
    expect(composeDraft()).toBe("");
    expect(readStoredDraft(owner.draftScope).text).toBe("");
    expect(readStoredDraft(owner.draftScope).error).toBe(messageOf(unknown));
  });

  test("leaving the pane, switching computers, or a new incarnation is not live", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "owned")!;
    selectPane("p2");
    expect(promptRequestIsLive(owner)).toBe(false);

    boot();
    expect(promptRequestIsLive(owner)).toBe(true);
    switchComposeView(() => {
      setAgentChat(false);
    });
    expect(promptRequestIsLive(owner)).toBe(false);

    boot();
    setCredential(pair("daemon-b"));
    attachLiveSession(sessionB as unknown as LiveSession);
    expect(promptRequestIsLive(owner)).toBe(false);
    expect(promptRequestOwnsComputer(owner)).toBe(false);

    boot();
    bumpViewIncarnation();
    expect(promptRequestIsLive(owner)).toBe(false);
    expect(currentViewIncarnation()).toBeGreaterThan(owner.viewIncarnation);
  });

  test("changing view unsticks busy without dropping the in-flight lock", () => {
    boot();
    const first = capturePromptRequest(sessionA, "p1", "first")!;
    expect(operationBusy()).toBe(true);
    bumpViewIncarnation();
    expect(operationBusy()).toBe(false);
    const second = acquirePromptLock();
    expect(second).not.toBeNull();
    expect(operationBusy()).toBe(true);
    expect(releasePromptLock(first.lockId)).toBe(false);
    expect(operationBusy()).toBe(true);
    expect(releasePromptLock(second!)).toBe(true);
    expect(operationBusy()).toBe(false);
  });

  test("success of an older revision does not erase a newer saved draft", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "first send")!;
    setComposeDraft("");
    bumpViewIncarnation();
    attachLiveSession(sessionB as unknown as LiveSession);
    boot({ session: sessionB });
    setComposeDraft("typed after reconnect");
    captureComposeDraft();
    settlePromptSuccess(owner);
    expect(composeDraft()).toBe("typed after reconnect");
    expect(readStoredDraft(currentComposeDraftScope()!).text).toBe("typed after reconnect");
  });

  test("apply restores a parked failure note only on agent chat", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "failed send")!;
    setComposeDraft("");
    selectPane("p2");
    const failed = new ProtocolError("timeout", "A failed");
    settlePromptFailure(owner, failed);
    expect(composeDraft()).toBe("");
    expect(chatSnapshot().agentTraceNote).toBe("");
    switchComposeView(() => {
      selectPane("p1");
    });
    expect(composeDraft()).toBe("failed send");
    expect(chatSnapshot().agentTraceNote).toBe(messageOf(failed));
  });

  test("an evicted attempt revision cannot settle a later attempt on the same scope", () => {
    boot();
    const first = capturePromptRequest(sessionA, "p1", "first send")!;
    bumpViewIncarnation();
    setOperationBusy(false);
    for (let i = 0; i < 32; i++) {
      writeStoredDraft({ daemonId: "daemon-a", paneId: `evict-${i}`, mode: "agent" }, { text: `filler-${i}` });
    }
    expect(readStoredDraft(first.draftScope).revision).toBe(0);
    boot();
    const second = capturePromptRequest(sessionA, "p1", "second send")!;
    expect(second.revision).toBeGreaterThan(first.revision);
    settlePromptFailure(first, new ProtocolError("timeout", "stale after eviction"));
    expect(readStoredDraft(second.draftScope).revision).toBe(second.revision);
    expect(readStoredDraft(second.draftScope).text).toBe("");
    expect(readStoredDraft(second.draftScope).error).toBe("");
    settlePromptSuccess(first);
    expect(readStoredDraft(second.draftScope).revision).toBe(second.revision);
  });

  test("failure restore is visible only for the current non-composing scope", () => {
    boot();
    const owner = capturePromptRequest(sessionA, "p1", "send me")!;
    setComposeDraft("");
    switchComposeView(() => {
      selectPane("p2");
    });
    const otherPane = settlePromptFailure(owner, new ProtocolError("timeout", "A failed"));
    expect(otherPane.restoredVisible).toBe(false);
    expect(composeDraft()).toBe("");
    expect(readStoredDraft(owner.draftScope).text).toBe("send me");

    boot();
    const composing = capturePromptRequest(sessionA, "p1", "typed")!;
    setComposeDraft("");
    setComposeIME(true);
    const duringIme = settlePromptFailure(composing, new ProtocolError("timeout", "A failed"));
    expect(duringIme.restoredVisible).toBe(false);
    expect(composeDraft()).toBe("");
  });
});