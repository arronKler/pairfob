import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { setNetworkOnline, setPhase } from "../../connection/connection-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { t } from "../../../lib/i18n";
import { applyPaneRead, resetPaneView, selectPane, seedPaneBuffer } from "../session-store";
import { SessionTerminal } from "./session-terminal";

const g = globalThis as unknown as Record<string, unknown>;
g.HTMLTextAreaElement = happy.HTMLTextAreaElement;
g.TouchEvent = happy.TouchEvent;
g.KeyboardEvent = happy.KeyboardEvent;

/** The pane is open and its view cleared, exactly as `openPane` leaves it. */
function visiting(connected = true): void {
  setPhase("live");
  setScreen("pane");
  attachLiveSession({ isConnected: () => connected, onEvent: () => () => undefined } as never);
  selectPane("p1");
  resetPaneView();
}

function reading(): Element | null {
  return appRoot().querySelector(".term-reading");
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setNetworkOnline(true);
  visiting();
});

afterEach(() => {
  unmountReact();
  resetPaneView();
  selectPane("");
  attachLiveSession(null);
  setNetworkOnline(true);
});

describe("the pane before its screen is read", () => {
  test("draws the screen arriving, not an empty buffer on the terminal's ground", () => {
    renderReact(createElement(SessionTerminal));

    const overlay = reading();
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute("role")).toBe("status");
    expect(overlay!.getAttribute("aria-live")).toBe("polite");
    expect(overlay!.getAttribute("aria-busy")).toBe("true");
    expect(overlay!.getAttribute("aria-label")).toBeTruthy();
    // Rows of shape, not a blank box: the placeholder has a screen's worth of lines.
    expect(overlay!.querySelectorAll(".term-reading-line").length).toBeGreaterThan(8);
    // Nothing to scroll or jump to yet.
    expect(appRoot().querySelector(".full-terminal-scroll")).toBeNull();
  });

  test("the first read replaces it with the screen", () => {
    renderReact(createElement(SessionTerminal));
    expect(reading()).not.toBeNull();

    act(() => applyPaneRead("ready", "h0"));

    expect(reading()).toBeNull();
    expect(appRoot().querySelector(".term")?.textContent).toContain("ready");
    expect(appRoot().querySelector(".full-terminal-scroll")).not.toBeNull();
  });

  test("a screen kept from the last visit is shown at once, with no reading state", () => {
    renderReact(createElement(SessionTerminal));
    act(() => {
      resetPaneView();
      seedPaneBuffer("last visit screen", "h1");
    });

    expect(reading()).toBeNull();
    expect(appRoot().querySelector(".term")?.textContent).toContain("last visit screen");
  });

  test("a screen read that came back empty still ends the reading state", () => {
    renderReact(createElement(SessionTerminal));

    act(() => applyPaneRead("", ""));

    expect(reading()).toBeNull();
  });

  test("with the computer out of reach the rows stand still and say why", () => {
    visiting(false);
    renderReact(createElement(SessionTerminal));

    const overlay = reading();
    expect(overlay!.className).toContain("is-still");
    expect(overlay!.getAttribute("aria-busy")).toBe("false");
    expect(overlay!.getAttribute("aria-label")).toBe(t("term.waitingComputer"));
    expect(appRoot().querySelector(".term-reading-note")?.textContent).toBe(t("term.waitingComputer"));
  });

  test("a device with no network waits the same way", () => {
    renderReact(createElement(SessionTerminal));
    expect(reading()!.className).not.toContain("is-still");

    act(() => setNetworkOnline(false));

    expect(reading()!.className).toContain("is-still");
    expect(reading()!.getAttribute("aria-busy")).toBe("false");
  });

  test("the wait moves again once the connection returns", () => {
    visiting(false);
    renderReact(createElement(SessionTerminal));
    expect(reading()!.className).toContain("is-still");

    act(() => setNetworkOnline(false));

    expect(reading()!.className).toContain("is-still");
    act(() => {
      attachLiveSession({ isConnected: () => true, onEvent: () => () => undefined } as never);
      setNetworkOnline(true);
    });

    expect(reading()!.className).not.toContain("is-still");
    expect(reading()!.getAttribute("aria-busy")).toBe("true");
    expect(appRoot().querySelector(".term-reading-note")).toBeNull();
  });

  test("a screen already on the pane stays through a lost connection", () => {
    renderReact(createElement(SessionTerminal));
    act(() => applyPaneRead("ready", "h0"));

    act(() => setNetworkOnline(false));

    expect(reading()).toBeNull();
    expect(appRoot().querySelector(".term")?.textContent).toContain("ready");
  });
});
