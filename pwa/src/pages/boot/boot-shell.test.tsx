import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
 * with the real clock: the slow wait counts up and the retry counts down.
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
});

afterEach(() => {
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
    expect(line(node)).toBe(t("boot.connectingLine"));
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
    await act(async () => { await pause(1_100); });
    expect(line(node)).toBe(t("slow.lineComputer", { n: "10" }));
    // Still loading: the placeholder rows keep their sheen.
    expect(node.querySelector(".herd-skeleton.is-still")).toBeNull();
  });

  test("a wait before pairfob.com answers is pinned on that hop", () => {
    // A fixed start: a source that re-read the clock would land after the render's own reading of it.
    const started = Date.now() - 9_000;
    setConnectionRecordSource(() => [{ event: "connect_start", at: started }]);
    const node = render(createElement(BootShell));
    expect(line(node)).toBe(t("slow.lineRelay", { n: "9" }));
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
    await act(async () => { await pause(1_100); });
    expect(note()).toContain(t("unreach.autoRetry", { n: "14" }));
    // The steps are the computer-side ones, with their commands.
    expect([...node.querySelectorAll(".conn-step code")].map((code) => code.textContent))
      .toEqual(["pairfob service status", "pairfob service restart"]);
  });
});
