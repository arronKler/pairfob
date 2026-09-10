import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { appHost } from "../../app/host";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { setComputers, computersStore } from "../../features/computers/catalog-store";
import { connectionStore, setPhase, type Phase } from "../../features/connection/connection-store";
import { currentScreen, navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { setLang, t } from "../../lib/i18n";
import type { PairResult } from "../../lib/protocol/client";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";
import { reloadComputers as reloadComputerCatalog } from "../../features/connection/lifecycle";

/**
 * Computers picker against the actual mounted App. Setup writes named typed
 * domain actions; the picker reads its computers domain by subscription. A
 * catalog reload publishes straight through the domain via the real
 * reloadComputerCatalog production implementation, driven with an injected
 * port whose loadCatalog returns the new catalog (no global module mock, no
 * facade adapter).
 */

function sample(id: string, hostname: string): PairResult {
  return {
    deviceId: "dev_abcdefgh",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: id,
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "iPhone",
    createdAt: 1_700_000_000_000,
    hostname,
    lastSeen: 1_700_000_000_000,
  } as PairResult;
}

function mountPicker(): void {
  act(() => {
    batch(() => {
      setPhase("pick");
      setScreen("computers");
    });
    mountApp();
  });
}

/** Minimal ports for reloadComputerCatalog: only loadCatalog is exercised. */
function reloadPorts(catalog: { credentials: PairResult[]; lastUsedDaemonId: string | null }) {
  return {
    loadCatalog: async () => catalog,
    origin: () => "https://pairfob.com",
  } as never;
}

/**
 * Wrap the live App host's commit methods with counters, calling through via
 * .call on the original method reference; restore the original references in
 * finally so the host's method identity is unchanged for later suites.
 */
function countHostCommits(): { finish: () => void; commits: () => number; requests: () => number } {
  const host = appHost() as Record<string, unknown>;
  const originalCommit = host.commit as unknown as (...args: unknown[]) => unknown;
  const originalRequest = host.requestCommit as unknown as (...args: unknown[]) => unknown;
  let commits = 0;
  let requests = 0;
  host.commit = (...args: unknown[]) => { commits += 1; return originalCommit.call(host, ...args); };
  host.requestCommit = (...args: unknown[]) => { requests += 1; return originalRequest.call(host, ...args); };
  return {
    commits: () => commits,
    requests: () => requests,
    finish: () => {
      host.commit = originalCommit;
      host.requestCommit = originalRequest;
    },
  };
}

/**
 * Foreign preimages of the fields this picker seeds (phase/screen in the mount
 * and the catalog rows), captured before the case runs so afterEach restores
 * the exact pre-case baseline through named owner actions instead of default
 * writes. The removed store.reset calls only dropped subscriber registries.
 */
const checkpoint = {
  phase: "boot" as Phase,
  screen: "home" as Screen,
  computers: [] as readonly PairResult[],
};

beforeEach(async () => {
  checkpoint.phase = connectionStore.get().phase;
  checkpoint.screen = navigationStore.get().screen;
  checkpoint.computers = computersStore.get().computers;
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  setLang("zh");
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    // Restore the captured preimages through named owner actions — not default
    // writes — while retaining external subscriber registries.
    setComputers(checkpoint.computers);
    setPhase(checkpoint.phase);
    setScreen(checkpoint.screen);
    await happy.happyDOM.abort();
  });
});

describe("computer picker copy (actual App)", () => {
  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    setComputers([sample("d_0123456789abcdef0123", "desk")]);
    mountPicker();
    const app = appRoot();
    expect(app.querySelector(".prelude-title")?.textContent).toBe(t("computers.offlineTitle"));
    expect(app.querySelector(".lede")?.textContent).toBe(t("computers.offlineLede"));
    expect(app.querySelectorAll(".computer-row")).toHaveLength(1);
    expect(app.querySelector(".switch-name")?.textContent).toBe("desk");
    act(() => setComputers([
      sample("d_0123456789abcdef0123", "desk"),
      sample("d_abcdef0123456789abcd", "studio"),
    ]));
    expect(app.querySelectorAll(".computer-row")).toHaveLength(2);
    expect(app.querySelector(".prelude-title")?.textContent).toBe(t("computers.pick"));
    expect(app.querySelector(".lede")?.textContent).toBe(t("computers.multiLede"));
  });

  test("adding another computer is a list row, not a ghost caption", () => {
    setComputers([sample("d_0123456789abcdef0123", "desk")]);
    mountPicker();
    const app = appRoot();
    const add = app.querySelector("button.switch-item.computer-add")!;
    expect(add).toBeTruthy();
    expect(add.querySelector(".add-mark")).toBeTruthy();
    expect(add.querySelector(".switch-name")?.textContent).toBe(t("settings.addComputer"));
    expect(add.querySelector(".switch-meta")?.textContent).toBe(t("computers.addHint"));
    expect(add.classList.contains("btn-ghost")).toBeFalse();
    expect([...app.querySelectorAll("p.lede")].some(p => p.textContent === t("computers.addHint"))).toBeFalse();
  });

  test("forgetting a computer is local and does not say revoke", () => {
    setComputers([sample("d_0123456789abcdef0123", "desk")]);
    mountPicker();
    const forget = appRoot().querySelector(".computer-forget")!;
    expect(forget).toBeTruthy();
    expect(forget.getAttribute("aria-label")).toBe(t("computers.forgetAria", { title: "desk" }));
    expect(forget.textContent).not.toContain("吊销这台设备");
  });

  test("a typed catalog replacement updates a mounted picker without an extra App commit", () => {
    setComputers([sample("d_0123456789abcdef0123", "desk")]);
    mountPicker();
    const counter = countHostCommits();
    try {
      const c0 = counter.commits();
      const r0 = counter.requests();
      act(() => setComputers([
        sample("d_0123456789abcdef0123", "desk"),
        sample("d_abcdef0123456789abcd", "studio"),
      ]));
      // Domain publication re-renders the subscribed picker; no App commit.
      expect(counter.commits()).toBe(c0);
      expect(counter.requests()).toBe(r0);
      expect(appRoot().querySelectorAll(".computer-row")).toHaveLength(2);
      expect(appRoot().querySelector(".prelude-title")?.textContent).toBe("选择电脑");
    } finally {
      counter.finish();
    }
  });

  test("a catalog reload publishes the fresh catalog to the subscribed picker with no App commit", async () => {
    setComputers([sample("d_0123456789abcdef0123", "desk")]);
    mountPicker();
    expect(appRoot().querySelectorAll(".computer-row")).toHaveLength(1);
    const counter = countHostCommits();
    try {
      const c0 = counter.commits();
      const r0 = counter.requests();
      await act(async () => {
        await reloadComputerCatalog(reloadPorts({
          credentials: [sample("d_abcdef0123456789abcd", "studio")],
          lastUsedDaemonId: null,
        }));
      });
      // Let any queued composition request settle inside act before measuring.
      await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      });
      // The reload only re-renders the subscribed picker through the computers
      // domain: it neither commits the app nor requests a composition commit.
      expect(counter.commits()).toBe(c0);
      expect(counter.requests()).toBe(r0);
      expect(appRoot().querySelectorAll(".computer-row")).toHaveLength(1);
      expect(appRoot().querySelector(".switch-name")?.textContent).toBe("studio");
    } finally {
      counter.finish();
    }
  });
});
