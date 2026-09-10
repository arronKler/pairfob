import { afterEach, describe, expect, test } from "bun:test";
import "../../test-support/boot-dom";

import type { AgentTraceItem } from "../lib/operations";
import type { AppHost } from "./host";

const { applyTrace, chatSnapshot, chatStore, resetTrace } = await import("../features/session/chat/trace-store");
const { connectionStore, setPhase } = await import("../features/connection/connection-store");
const { appHost, registerAppHost, releaseAppHost } = await import("./host");
const { batch } = await import("../shared/model/domain-store");
const { hasPendingComposition, publishAllDomains, publishPendingDomains } = await import("./domain-publication");
const { openPaneId, selectPane, sessionStore } = await import("../features/session/session-store");
const { setScreen } = await import("./navigation-store");
const { preferencesStore, setTermFontPx, termFontPx } = await import("../features/settings/preferences-store");

const host: AppHost = {
  commit: () => undefined,
  requestCommit: () => undefined,
  unmount: () => undefined,
};

function userTurn(text: string): AgentTraceItem {
  return { type: "user", text };
}

afterEach(() => {
  const active = appHost();
  if (active) releaseAppHost(active);
  resetTrace();
  // Named headless baseline restore: these owner writes mirror the historical
  // flat restore so later suites start from the same boot/home/pane state.
  setPhase("boot");
  selectPane("");
  setScreen("home");
  publishAllDomains();
});

describe("published snapshot read-after-write", () => {
  test("applyTrace inside a batch is visible to chatSnapshot before notify", () => {
    let notices = 0;
    const release = chatStore.subscribe(() => { notices += 1; });
    const items = [{ id: "t1", kind: "assistant", text: "hello" } as never];

    batch(() => {
      applyTrace({ agentTraceItems: items, agentTraceLoadState: "ready", agentTraceSig: "s1" });
      const snap = chatSnapshot();
      expect(snap.agentTraceItems).toEqual(items);
      expect(snap.agentTraceLoadState).toBe("ready");
      expect(snap).toBe(chatStore.get());
      expect(Object.isFrozen(snap)).toBeTrue();
      expect(notices).toBe(0);
    });

    expect(notices).toBe(1);
    expect(chatSnapshot().agentTraceItems).toEqual(items);
    release();
  });

  test("a composition stage does not freeze another domain's published snapshot", () => {
    registerAppHost(host);
    setPhase("boot");
    publishAllDomains();
    const beforePhase = connectionStore.get().phase;
    const items = [{ id: "t2", kind: "assistant", text: "later" } as never];

    setPhase("live");
    applyTrace({ agentTraceItems: items, agentTraceLoadState: "ready" });

    // Connection is staged: published phase stays boot until a commit transaction.
    expect(connectionStore.get().phase).toBe(beforePhase);
    expect(connectionStore.isCompositionPending()).toBeTrue();
    // Chat is an ordinary write: merge readers must see the new trace now.
    expect(chatSnapshot().agentTraceItems).toEqual(items);
    expect(chatSnapshot().agentTraceLoadState).toBe("ready");
  });
});

describe("chatSnapshot merge against composition holds", () => {
  test("applyTrace then chatSnapshot merge in one batch notifies once with both fields", () => {
    applyTrace({ agentTraceItems: [], agentTraceTail: 0 });
    const seen: Array<{ items: number; tail: number }> = [];
    const release = chatStore.subscribe(() => {
      seen.push({ items: chatSnapshot().agentTraceItems.length, tail: chatSnapshot().agentTraceTail });
    });

    batch(() => {
      applyTrace({ agentTraceItems: [userTurn("new")] });
      expect(chatSnapshot().agentTraceItems[0]?.text).toBe("new");
      expect(seen).toEqual([]);
      applyTrace({ agentTraceTail: chatSnapshot().agentTraceItems.length });
      expect(seen).toEqual([]);
    });

    release();
    expect(seen).toEqual([{ items: 1, tail: 1 }]);
    expect(chatSnapshot().agentTraceItems[0]?.text).toBe("new");
    expect(chatSnapshot().agentTraceTail).toBe(1);
  });

  test("that merge still sees the new trace while another domain is composition-staged", () => {
    registerAppHost(host);
    publishAllDomains();
    const publishedPhase = connectionStore.get().phase;
    const publishedPane = sessionStore.get().paneId;
    applyTrace({ agentTraceItems: [], agentTraceTail: 0 });
    const seen: Array<{ items: number; tail: number }> = [];
    const release = chatStore.subscribe(() => {
      seen.push({ items: chatSnapshot().agentTraceItems.length, tail: chatSnapshot().agentTraceTail });
    });

    setPhase("live");
    selectPane("p2");
    expect(hasPendingComposition()).toBeTrue();
    expect(connectionStore.isCompositionPending()).toBeTrue();
    expect(sessionStore.isCompositionPending()).toBeTrue();
    expect(connectionStore.get().phase).toBe(publishedPhase);
    expect(sessionStore.get().paneId).toBe(publishedPane);
    expect(openPaneId()).toBe("p2");

    batch(() => {
      applyTrace({ agentTraceItems: [userTurn("union")] });
      expect(chatSnapshot().agentTraceItems[0]?.text).toBe("union");
      expect(seen).toEqual([]);
      applyTrace({ agentTraceTail: chatSnapshot().agentTraceItems.length });
      expect(chatSnapshot().agentTraceTail).toBe(1);
      expect(seen).toEqual([]);
    });

    release();
    expect(seen).toEqual([{ items: 1, tail: 1 }]);
    expect(chatSnapshot().agentTraceItems[0]?.text).toBe("union");
    expect(chatSnapshot().agentTraceTail).toBe(1);
    expect(connectionStore.get().phase).toBe(publishedPhase);
    expect(sessionStore.get().paneId).toBe(publishedPane);
    expect(hasPendingComposition()).toBeTrue();
  });

  test("the same merge in one batch with a composition stage still reads the new page", () => {
    registerAppHost(host);
    publishAllDomains();
    const publishedPhase = connectionStore.get().phase;
    const seen: Array<{ items: number; tail: number }> = [];
    const release = chatStore.subscribe(() => {
      seen.push({ items: chatSnapshot().agentTraceItems.length, tail: chatSnapshot().agentTraceTail });
    });

    batch(() => {
      setPhase("live");
      selectPane("p2");
      applyTrace({ agentTraceItems: [userTurn("together")] });
      applyTrace({ agentTraceTail: chatSnapshot().agentTraceItems.length });
      expect(chatSnapshot().agentTraceItems[0]?.text).toBe("together");
      expect(chatSnapshot().agentTraceTail).toBe(1);
      expect(seen).toEqual([]);
    });

    release();
    expect(seen).toEqual([{ items: 1, tail: 1 }]);
    expect(connectionStore.get().phase).toBe(publishedPhase);
    expect(sessionStore.get().paneId).toBe("");
    expect(openPaneId()).toBe("p2");
    expect(hasPendingComposition()).toBeTrue();
  });

  test("a host without a pending composition still publishes chat immediately", () => {
    registerAppHost(host);
    publishAllDomains();
    expect(hasPendingComposition()).toBeFalse();
    const items = [userTurn("hosted")];
    let notices = 0;
    const release = chatStore.subscribe(() => { notices += 1; });

    batch(() => {
      applyTrace({ agentTraceItems: items });
      expect(chatSnapshot().agentTraceItems[0]?.text).toBe("hosted");
      applyTrace({ agentTraceTail: chatSnapshot().agentTraceItems.length });
      expect(notices).toBe(0);
    });

    release();
    expect(notices).toBe(1);
    expect(chatSnapshot().agentTraceTail).toBe(1);
    expect(hasPendingComposition()).toBeFalse();
  });

  test("chatSnapshot owns caller metadata and keeps a retained snapshot stable", () => {
    const items: AgentTraceItem[] = [userTurn("before")];
    applyTrace({ agentTraceItems: items, agentTracePendingBase: items });
    const first = chatSnapshot();
    expect(chatSnapshot()).toBe(first);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(first.agentTraceItems)).toBeTrue();
    expect(Object.isFrozen(first.agentTraceItems[0])).toBeTrue();

    items[0]!.text = "external";
    items.push(userTurn("extra"));
    expect(first.agentTraceItems.map((item) => item.text)).toEqual(["before"]);
    expect(() => {
      (first.agentTraceItems[0] as { text: string }).text = "mutate";
    }).toThrow();

    applyTrace({ agentTraceItems: [{ type: "assistant", text: "after" }] });
    expect(chatSnapshot()).not.toBe(first);
    expect(first.agentTraceItems[0]?.text).toBe("before");
    expect(chatSnapshot().agentTraceItems[0]?.text).toBe("after");
  });
});

describe("publication touches exactly what changed", () => {
  test("a staged pane write stays published-old with zero notice until the real publish", () => {
    registerAppHost(host);
    publishAllDomains();
    const publishedPane = sessionStore.get().paneId;
    let notices = 0;
    const release = sessionStore.subscribe(() => { notices += 1; });

    // selectPane stages the session domain (canonical new, published-old).
    selectPane("p9");
    expect(openPaneId()).toBe("p9");
    expect(sessionStore.get().paneId).toBe(publishedPane);
    expect(sessionStore.isCompositionPending()).toBeTrue();
    expect(notices).toBe(0);

    expect(publishPendingDomains()).toEqual(["session"]);
    expect(notices).toBe(1);
    expect(sessionStore.get().paneId).toBe("p9");
    expect(sessionStore.isDirty()).toBeFalse();
    release();
    releaseAppHost(host);
  });

  test("untouched domains keep their published snapshot identity", () => {
    publishAllDomains();
    const connectionBefore = connectionStore.get();
    const preferencesBefore = preferencesStore.get();
    // No pending write yet: a real flush sees nothing and changes no identity.
    expect(publishPendingDomains()).toEqual([]);
    expect(connectionStore.get()).toBe(connectionBefore);
    expect(preferencesStore.get()).toBe(preferencesBefore);

    // Install the recording host so the staged session write is genuinely held
    // (dirty, published-old) through the real pending publication flush.
    registerAppHost(host);
    selectPane("p2");
    expect(sessionStore.isCompositionPending()).toBeTrue();
    // Untouched during the held dirty window.
    expect(connectionStore.get()).toBe(connectionBefore);
    expect(preferencesStore.get()).toBe(preferencesBefore);
    const sessionBefore = sessionStore.get();

    publishPendingDomains();
    expect(sessionStore.get().paneId).toBe("p2");
    expect(sessionStore.get()).not.toBe(sessionBefore);
    // Untouched domains keep their published snapshot identity through the flush.
    expect(connectionStore.get()).toBe(connectionBefore);
    expect(preferencesStore.get()).toBe(preferencesBefore);
    releaseAppHost(host);
  });

  test("exactly the touched domains publish, and unchanged inputs notify nothing", () => {
    registerAppHost(host);
    publishAllDomains();
    // Capture the canonical font; establish a known distinct baseline before
    // subscribing so the to-15 write is real (setTermFontPx skips an unchanged
    // value) and the notification count is predictable.
    const baselineFont = termFontPx();
    setTermFontPx(baselineFont === 12 ? 13 : 12);
    publishPendingDomains();
    let sessionNotices = 0;
    let connNotices = 0;
    let prefNotices = 0;
    const releases = [
      sessionStore.subscribe(() => { sessionNotices += 1; }),
      connectionStore.subscribe(() => { connNotices += 1; }),
      preferencesStore.subscribe(() => { prefNotices += 1; }),
    ];
    try {
      // An unchanged named write must not publish at all.
      setPhase("boot");
      expect(connNotices).toBe(0);
      setScreen("home");
      expect(connNotices).toBe(0);

      // Touch three real domains (session staged, connection+preferences ordinary).
      setPhase("live");
      setTermFontPx(15);
      selectPane("p2");
      publishPendingDomains();
      expect(connNotices).toBe(1);
      expect(prefNotices).toBe(1);
      expect(sessionNotices).toBe(1);
      expect(connectionStore.get().phase).toBe("live");
      expect(preferencesStore.get().termFontPx).toBe(15);
      expect(sessionStore.get().paneId).toBe("p2");
    } finally {
      // Release only this case's listeners, then restore the captured canonical
      // font baseline even if an assertion above throws.
      for (const release of releases) release();
      setTermFontPx(baselineFont);
      publishPendingDomains();
      releaseAppHost(host);
    }
  });
});
