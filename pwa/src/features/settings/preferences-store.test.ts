import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { PairResult } from "../../lib/protocol/client";

const { preferencesStore, paneTermMode, setPaneTermMode, paneComposeLive, setPaneComposeLive, setDefaultComposeLive,
  setDefaultTermMode, setTermFont, setTermGrid, setKeysExpanded, setPadKind, rememberPane, applyHerdTouches, togglePanePin,
  prunePanePreferences, prunePanePins, adoptDaemonPreferences, clampTermFont, termLineHeightPx, saveListGroup,
  setListGroup, TERM_FONT_MAX, TERM_FONT_MIN } = await import("./preferences-store");
const { computersStore, setCredential } = await import("../computers/catalog-store");

function credential(daemonId: string): PairResult {
  return {
    daemonId,
    deviceId: "dev_phone01",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com",
    fp: "fp_test",
    label: "Phone",
    createdAt: 1,
  };
}

const previousCredential = computersStore.get().credential;

afterEach(() => {
  setCredential(previousCredential);
  adoptDaemonPreferences();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("pairfob:pane") || key.startsWith("pairfob:completionSeen")) localStorage.removeItem(key);
  }
});

describe("terminal and pad preferences", () => {
  test("font size clamps to the shipped range and derives the row pitch", () => {
    expect(clampTermFont(Number.NaN)).toBe(12);
    expect(clampTermFont(4)).toBe(TERM_FONT_MIN);
    expect(clampTermFont(99)).toBe(TERM_FONT_MAX);
    expect(termLineHeightPx(12)).toBe(18);
    expect(termLineHeightPx(20)).toBe(30);

    const before = preferencesStore.get().termFontPx;
    let publishes = 0;
    const release = preferencesStore.subscribe(() => { publishes += 1; });
    setTermFont(before);
    expect(publishes).toBe(0);
    setTermFont(TERM_FONT_MAX + 40);
    expect(preferencesStore.get().termFontPx).toBe(TERM_FONT_MAX);
    expect(localStorage.getItem("pairfob:termFont")).toBe(String(TERM_FONT_MAX));
    expect(publishes).toBe(1);
    setTermFont(before);
    release();
  });

  test("grid, keypad and list choices persist and publish to their own subscribers", () => {
    let publishes = 0;
    const release = preferencesStore.subscribe(() => { publishes += 1; });

    setTermGrid("fit", 120);
    expect(localStorage.getItem("pairfob:termFit")).toBe("fit");
    expect(localStorage.getItem("pairfob:termCols")).toBe("120");
    setKeysExpanded(true);
    expect(localStorage.getItem("pairfob:keysExpanded")).toBe("1");
    setPadKind("slash");
    expect(localStorage.getItem("pairfob:padKind")).toBe("slash");
    setListGroup("space");
    saveListGroup();
    expect(localStorage.getItem("pairfob:listGroup")).toBe("space");
    setDefaultComposeLive(true);
    expect(localStorage.getItem("pairfob:defaultComposeLive")).toBe("1");
    setDefaultTermMode("agent");
    expect(localStorage.getItem("pairfob:defaultTermMode")).toBe("agent");

    expect(publishes).toBe(6);
    expect(preferencesStore.get().termFit).toBe("fit");
    expect(preferencesStore.get().padKind).toBe("slash");

    setTermGrid("pan", 80);
    setKeysExpanded(false);
    setPadKind("keys");
    setListGroup("flat");
    setDefaultComposeLive(false);
    setDefaultTermMode("auto");
    release();
  });
});

describe("per-pane preferences", () => {
  test("a pane mode and compose choice persist under the connected daemon", () => {
    setCredential(credential("d_aaaaaaaaaaaaaaaaaaaa"));
    adoptDaemonPreferences();

    setPaneTermMode("p1", "full");
    setPaneComposeLive("p1", true);
    expect(paneTermMode("p1")).toBe("full");
    expect(paneTermMode("p2")).toBe(preferencesStore.get().defaultTermMode);
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBe(preferencesStore.get().defaultComposeLive);
    expect(localStorage.getItem("pairfob:paneTermMode:d_aaaaaaaaaaaaaaaaaaaa")).toBe('{"p1":"full"}');
    expect(localStorage.getItem("pairfob:paneComposeLive:d_aaaaaaaaaaaaaaaaaaaa")).toBe('{"p1":true}');

    // A repeated identical choice is not a change, so it does not repaint.
    let publishes = 0;
    const release = preferencesStore.subscribe(() => { publishes += 1; });
    setPaneTermMode("p1", "full");
    setPaneComposeLive("p1", true);
    expect(publishes).toBe(0);
    release();
  });

  test("another computer never reads the first computer's pane choices", () => {
    setCredential(credential("d_aaaaaaaaaaaaaaaaaaaa"));
    adoptDaemonPreferences();
    setPaneTermMode("p1", "full");

    setCredential(credential("d_bbbbbbbbbbbbbbbbbbbb"));
    adoptDaemonPreferences();
    expect(paneTermMode("p1")).toBe(preferencesStore.get().defaultTermMode);

    setPaneTermMode("p1", "agent");
    expect(localStorage.getItem("pairfob:paneTermMode:d_bbbbbbbbbbbbbbbbbbbb")).toBe('{"p1":"agent"}');
    expect(localStorage.getItem("pairfob:paneTermMode:d_aaaaaaaaaaaaaaaaaaaa")).toBe('{"p1":"full"}');

    setCredential(credential("d_aaaaaaaaaaaaaaaaaaaa"));
    adoptDaemonPreferences();
    expect(paneTermMode("p1")).toBe("full");
  });

  test("pruning drops dead panes and keeps every live choice", () => {
    setCredential(credential("d_aaaaaaaaaaaaaaaaaaaa"));
    adoptDaemonPreferences();
    setPaneTermMode("p1", "full");
    setPaneTermMode("p2", "agent");
    setPaneComposeLive("p2", true);
    rememberPane("p2");
    togglePanePin("p2");

    prunePanePreferences(["p1"]);
    prunePanePins(["p1"]);

    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "full" });
    expect(preferencesStore.get().paneComposeLive).toEqual({});
    expect(preferencesStore.get().panePinned).toEqual({});
    expect(preferencesStore.get().paneTouched.p2).toBeNumber();
    expect(localStorage.getItem("pairfob:paneTermMode:d_aaaaaaaaaaaaaaaaaaaa")).toBe('{"p1":"full"}');

    // An empty live list means "no snapshot yet", not "everything is gone".
    prunePanePreferences([]);
    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "full" });
  });

  test("applyHerdTouches stamps status changes through the same map rememberPane writes", () => {
    setCredential(credential("d_aaaaaaaaaaaaaaaaaaaa"));
    adoptDaemonPreferences();
    const card = (paneId: string, status: "idle" | "working") => ({
      paneId, paneLabel: paneId, agent: "codex", status, workspaceId: "w", workspaceLabel: "w", cwd: "/tmp",
    });
    applyHerdTouches([], [card("p1", "idle")], 10);
    expect(preferencesStore.get().paneTouched.p1).toBe(10);
    applyHerdTouches([card("p1", "idle")], [card("p1", "working")], 20);
    expect(preferencesStore.get().paneTouched.p1).toBe(20);
    const before = preferencesStore.get().paneTouched;
    applyHerdTouches([card("p1", "working")], [card("p1", "working")], 30);
    expect(preferencesStore.get().paneTouched).toEqual(before);
  });
});
