import { expectSameNode } from "../../test-support/node-identity";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { appRoot } from "./dom-root";
import { commitsHeld, holdCommits } from "./host";
import { morphingPane, navigateWithTransition, nextTransition, queuedKind, resetTransitionState } from "./transition";

/**
 * The list ↔ pane container transform (`navigateWithTransition`).
 *
 * The only asynchronous navigation boundary: with the native API the commit runs
 * in the deferred update callback so the list is captured first, and the commit
 * pipeline is held until then. Every other navigation keeps the synchronous
 * controller path, which the sync-boundary suites cover.
 */

type Box = { top: number; left: number; width: number; height: number };

function place(element: Element, box: Box): void {
  (element as HTMLElement).getBoundingClientRect = () => ({
    ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON() { return box; },
  }) as DOMRect;
}

function listPage(paneId = "p1", box: Box = { top: 120, left: 16, width: 358, height: 64 }): HTMLElement {
  appRoot().innerHTML = `<main class="page"><article class="card"><button class="card-main" data-pane-id="${paneId}">`
    + `<span class="agent-avatar"></span><span class="card-copy"><span class="card-title"><span class="card-name">fix</span></span></span>`
    + `</button></article></main>`;
  const card = appRoot().querySelector<HTMLElement>(".card-main")!;
  place(card, box);
  place(card.querySelector(".agent-avatar")!, { top: box.top + 12, left: box.left + 12, width: 40, height: 40 });
  place(card.querySelector(".card-name")!, { top: box.top + 14, left: box.left + 64, width: 60, height: 20 });
  return card;
}

function panePage(): void {
  appRoot().innerHTML = `<div class="pane-root"><header class="chrome"><span class="chrome-back"><button class="back"></button></span>`
    + `<div class="chrome-title"><span class="chrome-avatar"><span class="agent-avatar"></span></span>`
    + `<span class="chrome-copy"><span class="chrome-name">fix</span><span class="chrome-meta">working</span></span></div>`
    + `<div class="chrome-actions"></div></header><div class="term-stage"></div></div>`;
  const root = appRoot().querySelector(".pane-root")!;
  place(root, { top: 0, left: 0, width: 390, height: 844 });
  place(root.querySelector(".chrome-avatar")!, { top: 11, left: 52, width: 30, height: 30 });
  place(root.querySelector(".chrome-name")!, { top: 12, left: 92, width: 200, height: 20 });
}

function names(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const element of document.querySelectorAll<HTMLElement>("*")) {
    const name = element.style.getPropertyValue("view-transition-name");
    if (name) found[name] = element.className;
  }
  return found;
}

type NativeStub = { update?: () => void; finish: () => void; skipped: number; starts: number };

function installNative(): NativeStub {
  const stub: NativeStub = { finish: () => undefined, skipped: 0, starts: 0 };
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => void) => {
      stub.starts += 1;
      stub.update = update;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      let updated!: () => void;
      const updateCallbackDone = new Promise<void>((resolve) => { updated = resolve; });
      stub.finish = finish;
      const run = stub.update;
      stub.update = () => { run(); updated(); };
      return { finished, updateCallbackDone, skipTransition: () => { stub.skipped += 1; } };
    },
  });
  return stub;
}

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  resetTransitionState();
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
});

afterEach(() => {
  resetTransitionState();
  delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
  appRoot().replaceChildren();
});

describe("list ↔ pane transition", () => {
  test("without a morph it is the synchronous controller path with the declared fallback", async () => {
    installNative();
    let commits = 0;
    nextTransition("push", "p1");
    const done = navigateWithTransition(() => { commits += 1; }, null);
    expect(commits).toBe(1);
    expect(queuedKind()).toBe("none");
    expect(document.documentElement.dataset.fallbackTransition).toBe("push");
    await done;
  });

  test("a new session with no tapped card on screen gets the ordinary push, never a faked flight", () => {
    const stub = installNative();
    const card = listPage("p1", { top: 0, left: 0, width: 0, height: 0 });
    let commits = 0;
    nextTransition("push", "p1");
    void navigateWithTransition(() => { commits += 1; panePage(); }, { direction: "open", paneId: "p1", source: card });
    expect(commits).toBe(1);
    expect(stub.starts).toBe(0);
    expect(names()).toEqual({});
    expect(document.documentElement.dataset.fallbackTransition).toBe("push");
  });

  test("native open captures the list first, holds commits, then names the arriving pane and clears every name", async () => {
    const stub = installNative();
    const card = listPage();
    let commits = 0;
    nextTransition("push", "p1");
    let arrived = false;
    const done = navigateWithTransition(() => { commits += 1; panePage(); },
      { direction: "open", paneId: "p1", source: card.querySelector<HTMLElement>(".card-name") });
    void done.then(() => { arrived = true; });
    // Old side named, nothing committed, the pipeline held until the capture.
    expect(stub.starts).toBe(1);
    expect(commits).toBe(0);
    expect(commitsHeld()).toBeTrue();
    expect(document.documentElement.dataset.transition).toBe("morph-open");
    expect(names()).toEqual({ "pane-container": "card-main", "pane-avatar": "agent-avatar", "pane-title": "card-name" });
    await flush();
    expect(arrived).toBeFalse();
    stub.update!();
    expect(commits).toBe(1);
    expect(commitsHeld()).toBeFalse();
    // One element per name: the old card left with the commit.
    expect(names()).toEqual({
      "pane-container": "pane-root", "pane-avatar": "chrome-avatar", "pane-title": "chrome-name",
      "pane-meta": "chrome-meta", "pane-actions": "chrome-actions",
    });
    await flush();
    expect(arrived).toBeTrue();
    stub.finish();
    await flush();
    expect(names()).toEqual({});
    expect(document.documentElement.dataset.transition).toBeUndefined();
    expect(morphingPane()).toBeNull();
  });

  test("native close lands on the card only when it is on screen", async () => {
    for (const visible of [true, false]) {
      resetTransitionState();
      const stub = installNative();
      panePage();
      nextTransition("pop", "p1");
      const done = navigateWithTransition(() => {
        listPage("p1", visible ? { top: 200, left: 16, width: 358, height: 64 } : { top: 1200, left: 16, width: 358, height: 64 });
      }, { direction: "close", paneId: "p1" });
      expect(names()).toEqual({ "pane-container": "pane-root", "pane-avatar": "chrome-avatar", "pane-title": "chrome-name" });
      expect(document.documentElement.dataset.transition).toBe("morph-close");
      stub.update!();
      await done;
      // Off screen: the pane just fades out instead of flying to the wrong place.
      expect(names()).toEqual(visible
        ? { "pane-container": "card-main", "pane-avatar": "agent-avatar", "pane-title": "card-name" }
        : {});
      stub.finish();
      await flush();
      expect(names()).toEqual({});
    }
  });

  test("a newer navigation skips the pending one and releases its hold without committing it", async () => {
    const stub = installNative();
    const card = listPage();
    let commits = 0;
    nextTransition("push", "p1");
    void navigateWithTransition(() => { commits += 1; panePage(); }, { direction: "open", paneId: "p1", source: card });
    expect(commitsHeld()).toBeTrue();
    const first = stub.update!;
    nextTransition("push", "p1");
    void navigateWithTransition(() => { commits += 1; panePage(); }, { direction: "open", paneId: "p1", source: card });
    expect(stub.skipped).toBe(1);
    expect(stub.starts).toBe(2);
    // The superseded callback is inert; only the newer one commits.
    first();
    expect(commits).toBe(0);
    stub.update!();
    expect(commits).toBe(1);
    expect(commitsHeld()).toBeFalse();
  });

  test("teardown releases a pending hold and leaves no names or markers", () => {
    installNative();
    const card = listPage();
    nextTransition("push", "p1");
    void navigateWithTransition(() => panePage(), { direction: "open", paneId: "p1", source: card });
    expect(commitsHeld()).toBeTrue();
    resetTransitionState();
    expect(commitsHeld()).toBeFalse();
    expect(names()).toEqual({});
    expect(document.documentElement.dataset.transition).toBeUndefined();
  });

  test("reduced motion commits at once with only the short fade", () => {
    const stub = installNative();
    const realMatch = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
    try {
      const card = listPage();
      let commits = 0;
      nextTransition("push", "p1");
      void navigateWithTransition(() => { commits += 1; panePage(); }, { direction: "open", paneId: "p1", source: card });
      expect(commits).toBe(1);
      expect(stub.starts).toBe(0);
      expect(names()).toEqual({});
      expect(document.documentElement.dataset.fallbackTransition).toBe("reduced");
    } finally {
      globalThis.matchMedia = realMatch;
    }
  });

  test("the desk layout keeps its fade: list and pane are already side by side", () => {
    const stub = installNative();
    happy.happyDOM.setWindowSize({ width: 1280, height: 900 });
    const card = listPage();
    nextTransition("push", "p1");
    void navigateWithTransition(() => panePage(), { direction: "open", paneId: "p1", source: card });
    expect(stub.starts).toBe(0);
    expect(document.documentElement.dataset.fallbackTransition).toBe("fade");
  });

  test("without the native API the pane grows over a static copy of the list (FLIP)", async () => {
    const animated: Array<{ className: string; frames: Keyframe[] }> = [];
    const finishers: Array<() => void> = [];
    const realAnimate = happy.HTMLElement.prototype.animate;
    happy.HTMLElement.prototype.animate = function (this: HTMLElement, frames: Keyframe[]) {
      animated.push({ className: this.className, frames });
      let resolve!: () => void;
      const finished = new Promise<void>((done) => { resolve = done; });
      finishers.push(resolve);
      return { finished, cancel() {} } as unknown as Animation;
    } as typeof realAnimate;
    try {
      const card = listPage();
      let commits = 0;
      nextTransition("push", "p1");
      void navigateWithTransition(() => { commits += 1; panePage(); }, { direction: "open", paneId: "p1", source: card });
      expect(commits).toBe(1);
      const under = document.querySelector(".pane-morph-under");
      expectSameNode(under?.nextElementSibling, appRoot());
      expect(under?.querySelector(".card-main")).not.toBeNull();
      expect(document.documentElement.dataset.morph).toBe("open");
      const pane = animated.find((entry) => entry.className === "pane-root")!;
      expect(String(pane.frames[0]!.clipPath)).toBe("inset(120px 16px 660px 16px round 14px)");
      // Avatar and title travel with one uniform scale, from the card's spot.
      const avatar = animated.find((entry) => entry.className === "chrome-avatar")!;
      expect(avatar.frames[0]!.transform).toBe(`translate(-24px, 121px) scale(${40 / 30})`);
      expect(names()).toEqual({});
      for (const finish of finishers) finish();
      await flush();
      expect(document.querySelector(".pane-morph-under")).toBeNull();
      expect(document.documentElement.dataset.morph).toBeUndefined();
    } finally {
      happy.HTMLElement.prototype.animate = realAnimate;
    }
  });
});

describe("commit hold", () => {
  test("holds are per navigation and releasing twice is harmless", () => {
    const first = holdCommits();
    const second = holdCommits();
    first();
    first();
    expect(commitsHeld()).toBeTrue();
    second();
    expect(commitsHeld()).toBeFalse();
  });
});
