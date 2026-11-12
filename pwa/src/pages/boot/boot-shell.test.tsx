import { resetTestDOM } from "../../../test-support/boot-dom";
import { expectSameNode, expectSameNodes } from "../../../test-support/node-identity";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PairResult } from "../../lib/protocol/client";
import { setLang, t } from "../../lib/i18n";
import { attachLiveSession, setComputers, setCredential } from "../../features/computers/catalog-store";
import { setConnectionRecordSource } from "../../features/connection/connection-path";
import { setConnectFailure, setPhase, setRetryingUnreachable } from "../../features/connection/connection-store";
import { BootShell } from "./boot-shell";
import { UnreachableShell } from "./unreachable-shell";

/**
 * The boot frame and the single-computer failure page, rendered on their own
 * on a fake clock: the slow wait counts up and the retry counts down.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

/** Advance the fake clock and flush the promises the shell resolves on. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function computer(): PairResult {
  return {
    deviceId: "dev_abcdefgh", psk: new Uint8Array(32), daemonPk: new Uint8Array(32), daemonId: "d_aaaaaaaaaaaaaaaaaaaa",
    fp: "0".repeat(16), relayOrigin: "https://pairfob.com", label: "iPhone", createdAt: 1, hostname: "Studio", lastSeen: 0,
  };
}

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
  act(() => {
    setComputers([computer()]);
    setCredential(computer());
    setPhase("resuming");
  });
  // The countdown and the slow-wait reveal are timer behavior; drive them
  // on a fake clock instead of sleeping through real seconds.
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  setConnectionRecordSource(null);
  act(() => {
    setConnectFailure("");
    setRetryingUnreachable(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setPhase("boot");
  });
});

const line = (node: HTMLElement) => node.querySelector(".host-title-line")?.textContent ?? "";

describe("the boot frame while connecting", () => {
  test("a fresh connect only says it is connecting", () => {
    setConnectionRecordSource(() => [{ event: "connect_start", at: Date.now() }]);
    const node = render(createElement(BootShell));
    expect(node.querySelector(".host-title-name")?.textContent).toBe("Studio");
    expect(line(node)).toBe(t("boot.connectingLine", { relay: "pairfob.com" }));
    expect(node.querySelector(".conn-path-card")).toBeNull();
    expect(node.querySelector(".herd-skeleton")).not.toBeNull();
  });

  test("past the threshold it names the hop it waits on, and the seconds keep counting", async () => {
    const started = Date.now() - 9_000;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }, { event: "ws_open", at: started + 300 }]);
    const node = render(createElement(BootShell));
    expect(line(node)).toBe(t("slow.lineComputer", { n: "9" }));
    expect([...node.querySelectorAll(".conn-node small")].map((small) => small.textContent))
      .toEqual([t("path.phoneOk"), t("path.relayOk"), t("path.waitingSeconds", { n: "9" })]);
    await advance(1_100);
    expect(line(node)).toBe(t("slow.lineComputer", { n: "10" }));
    // Still loading: the placeholder rows keep their sheen.
    expect(node.querySelector(".herd-skeleton.is-still")).toBeNull();
  });

  test("a wait before pairfob.com answers is pinned on that hop", () => {
    // A fixed start: a source that re-read the clock would land after the render's own reading of it.
    const started = Date.now() - 9_000;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }]);
    const node = render(createElement(BootShell));
    expect(line(node)).toBe(t("slow.lineRelay", { n: "9", relay: "pairfob.com" }));
  });

  test("a retry started from the failure page keeps that page up, spinning", () => {
    act(() => {
      setConnectFailure("daemon_offline");
      setRetryingUnreachable(true);
    });
    const node = render(createElement(BootShell));
    expect(node.querySelector(".unreachable-shell")).not.toBeNull();
    expect(node.querySelector<HTMLButtonElement>(".conn-retry")?.disabled).toBe(true);
    expect(node.querySelector(".conn-retry")?.textContent).toBe(t("unreach.retrying"));
  });
});

describe("the single-computer failure page", () => {
  test("it counts down to the next automatic retry", async () => {
    act(() => {
      setConnectFailure("daemon_offline");
      setPhase("pick");
    });
    const node = render(createElement(UnreachableShell));
    // This test computer has never connected, so "last connected" reads "never".
    expect(line(node)).toBe(t("unreach.lineComputer", { when: t("device.never") }));
    const note = () => node.querySelector(".conn-retry-note")?.textContent ?? "";
    expect(note()).toContain(t("unreach.autoRetry", { n: "15" }));
    await advance(1_100);
    expect(note()).toContain(t("unreach.autoRetry", { n: "14" }));
    // The steps are the computer-side ones, with their commands.
    expect([...node.querySelectorAll(".conn-step code")].map((code) => code.textContent))
      .toEqual(["pairfob service status", "pairfob service restart"]);
  });
});

/**
 * What moves on the route and what must not. The card is redrawn every second
 * while it counts, so each move hangs on a hop changing state, never on a draw.
 */
describe("the connection path's moves", () => {
  const smalls = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>(".conn-node small")];
  const links = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>(".conn-link")];
  const badges = (node: HTMLElement) => [...node.querySelectorAll<HTMLElement>(".conn-node")].map((item) => item.querySelector<HTMLElement>(".conn-node-badge"));

  test("the card's place is there shut from the start, and opens when the wait turns slow", async () => {
    const started = Date.now() - 7_300;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }]);
    const node = render(createElement(BootShell));
    const fold = node.querySelector<HTMLElement>(".boot-shell > .fold")!;
    expect(fold.classList.contains("is-shut")).toBeTrue();
    expect(fold.hasAttribute("inert")).toBeTrue();
    expect(fold.querySelector(".conn-path-card")).toBeNull();
    // It stands between the header and the rows it will move down.
    expect(fold.previousElementSibling?.className).toBe("herd-head");
    expect(fold.nextElementSibling?.classList.contains("herd-skeleton")).toBeTrue();
    await advance(1_100);
    expectSameNode(node.querySelector(".boot-shell > .fold"), fold);
    expect(fold.classList.contains("is-shut")).toBeFalse();
    expect(fold.hasAttribute("inert")).toBeFalse();
    expect(fold.querySelector(".conn-path-card")).not.toBeNull();
  });

  test("a newer attempt shuts the card with what it last said still in it, then lets it go", async () => {
    let records = [{ event: "connect_start", at: Date.now() - 9_000 }];
    setConnectionRecordSource(() => records);
    const node = render(createElement(BootShell));
    const fold = node.querySelector<HTMLElement>(".boot-shell > .fold")!;
    const card = fold.querySelector(".conn-path-card");
    expect(card).not.toBeNull();
    records = [{ event: "connect_start", at: Date.now() }];
    await advance(1_050);
    // Shut and out of reach; by now its exit is over and the card is gone.
    expect(fold.classList.contains("is-shut")).toBeTrue();
    expect(fold.hasAttribute("inert")).toBeTrue();
    await advance(300);
    expect(fold.querySelector(".conn-path-card")).toBeNull();
    expect(line(node)).toBe(t("boot.connectingLine", { relay: "pairfob.com" }));
  });

  test("a frame drawn while already slow shows the card open and still", () => {
    const started = Date.now() - 9_000;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }]);
    const node = render(createElement(BootShell));
    const fold = node.querySelector<HTMLElement>(".boot-shell > .fold")!;
    expect(fold.className).toBe("fold");
    expect(node.querySelector(".pop-in, .swap-in")).toBeNull();
  });

  test("counting a wait redraws the card without a move", async () => {
    const started = Date.now() - 9_000;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }, { event: "ws_open", at: started + 300 }]);
    const node = render(createElement(BootShell));
    const before = { notes: smalls(node), links: links(node), badges: badges(node) };
    await advance(1_100);
    expect(smalls(node).at(-1)?.textContent).toBe(t("path.waitingSeconds", { n: "10" }));
    // The same elements, one of them saying a later second.
    expectSameNodes(smalls(node), before.notes);
    expectSameNodes(links(node), before.links);
    expectSameNodes(badges(node), before.badges);
    expect(node.querySelector(".pop-in, .swap-in")).toBeNull();
  });

  test("a hop coming through keeps its link to be drawn across, pops the node's check and swaps its note", async () => {
    const started = Date.now() - 9_000;
    let records = [{ event: "connect_start", at: started }];
    setConnectionRecordSource(() => records);
    const node = render(createElement(BootShell));
    const [first, second] = links(node);
    expect([first.className, second.className]).toEqual(["conn-link is-wait", "conn-link is-idle"]);
    expect(badges(node).map((badge) => badge?.className ?? null)).toEqual(["conn-node-badge", null, null]);
    const phone = badges(node)[0];
    records = [...records, { event: "ws_open", at: started + 9_200 }];
    await advance(1_100);
    // The links are the same elements with a new state: the stylesheet's transition has something to run on.
    expectSameNodes(links(node), [first, second]);
    expect([first.className, second.className]).toEqual(["conn-link is-ok", "conn-link is-wait"]);
    const [phoneBadge, relayBadge, computerBadge] = badges(node);
    // This device's check was drawn with the card; pairfob.com's has just been reached.
    expectSameNode(phoneBadge, phone);
    expect(phoneBadge?.classList.contains("pop-in")).toBeFalse();
    expect(relayBadge?.className).toBe("conn-node-badge pop-in");
    expect(computerBadge).toBeNull();
    const [phoneNote, relayNote, computerNote] = smalls(node);
    expect(phoneNote.classList.contains("swap-in")).toBeFalse();
    expect(relayNote.textContent).toBe(t("path.relayOk"));
    expect(relayNote.classList.contains("swap-in")).toBeTrue();
    expect(computerNote.classList.contains("swap-in")).toBeTrue();
    // The next second is only a count.
    await advance(1_100);
    expectSameNodes(smalls(node), [phoneNote, relayNote, computerNote]);
    expectSameNode(badges(node)[1], relayBadge);
  });

  test("the retry button keeps one box for its mark and reserves the other wording; the line under it is never empty", () => {
    act(() => {
      setConnectFailure("daemon_offline");
      setPhase("pick");
    });
    const idle = render(createElement(UnreachableShell));
    const label = idle.querySelector<HTMLElement>(".conn-retry-label")!;
    expect(label.textContent).toBe(t("unreach.retryNow"));
    expect(label.dataset.reserve).toBe(t("unreach.retrying"));
    expect(idle.querySelector(".conn-retry-mark svg")).not.toBeNull();
    expect(idle.querySelector(".conn-retry-mark .spinner")).toBeNull();
    expect(idle.querySelector<HTMLButtonElement>(".conn-retry-add")?.disabled).toBeFalse();
    act(() => { root?.unmount(); });
    host?.remove();
    const busy = render(createElement(UnreachableShell, { retrying: true }));
    const busyLabel = busy.querySelector<HTMLElement>(".conn-retry-label")!;
    expect(busyLabel.textContent).toBe(t("unreach.retrying"));
    expect(busyLabel.dataset.reserve).toBe(t("unreach.retryNow"));
    expect(busy.querySelector(".conn-retry-mark .spinner")).not.toBeNull();
    expect(busy.querySelector(".conn-retry-mark svg")).toBeNull();
    // No countdown to show, and no adding while a retry runs: the link holds the line, held.
    expect(busy.querySelector(".conn-retry-note")?.textContent).toBe(t("unreach.add"));
    expect(busy.querySelector<HTMLButtonElement>(".conn-retry-add")?.disabled).toBeTrue();
  });
});
