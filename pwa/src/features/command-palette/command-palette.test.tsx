import { expectSameNode } from "../../../test-support/node-identity";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { hasOpenDialog } from "../../lib/dom";
import { setLang, t } from "../../lib/i18n";
import { bindOverlayOrigin } from "../../shared/ui/overlay";
import { buildHerdViewModel, type HerdModelInput } from "../dashboard/model/herd-view";
import { openCommandPalette, provideCommandPalette, type CommandPalettePorts, type PaletteInput } from "./index";

function agent(id: string, status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: "pairfob", workspaceLabel: "pairfob", cwd: "/work/pairfob", tabId: "pairfob:tab", tabLabel: "implementation",
  };
}

function source(agents: DashboardAgentCard[], overrides: Partial<HerdModelInput> = {}): PaletteInput {
  return {
    view: buildHerdViewModel({
      agents, listGroup: "flat", paneTouched: {}, paneActivated: {}, panePinned: {}, groupCollapsed: {}, selectedPaneId: "",
      attention: { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] },
      liveness: "live", status: { tone: "live", text: "connected" }, reading: false, snapshotLoaded: true, recentDirs: [],
      connected: true, networkOnline: true, runtimeKind: "herdr", createConversation: true, operationBusy: false,
      computerCount: 1, morphingPaneId: null, host: { name: "studio", line: "connected", tone: "live" }, createTab: true,
      now: 60 * 60_000, ...overrides,
    }),
    activated: {},
    currentPaneId: "",
  };
}

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const dialogs = () => [...document.querySelectorAll<HTMLDialogElement>("dialog.command-palette")];
const field = () => dialogs()[0].querySelector<HTMLInputElement>("input")!;
const options = () => [...dialogs()[0].querySelectorAll<HTMLElement>("[role=option]")];
const activeText = () => document.getElementById(field().getAttribute("aria-activedescendant") ?? "")
  ?.querySelector(".palette-name, .palette-label")?.textContent ?? null;

let current: PaletteInput;
let listeners: Set<() => void>;
let events: string[];
let opener: HTMLButtonElement;

function ports(): CommandPalettePorts {
  return {
    read: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    openSession: (paneId) => { events.push(`open:${paneId}`); },
    runAction: (action) => { events.push(`run:${action}`); },
  };
}

function open(): void {
  act(() => openCommandPalette());
}

function key(name: string, init: KeyboardEventInit = {}, keyCode?: number): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  act(() => { field().dispatchEvent(event); });
  return event;
}

function type(value: string): void {
  const input = field();
  act(() => {
    // A controlled field: set through the prototype so React's value tracker
    // sees the change, and follow with the key event happy-dom reads it on.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  current = source([agent("build"), agent("ask", "blocked"), agent("docs", "working")]);
  listeners = new Set();
  events = [];
  provideCommandPalette(ports());
  opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
});

afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  provideCommandPalette(null);
  opener.remove();
});

describe("command palette", () => {
  test("opens as a modal combobox with the next waiting session highlighted", () => {
    open();
    const [dialog] = dialogs();
    expect(dialog.open).toBeTrue();
    expect(hasOpenDialog()).toBeTrue();
    expect(dialog.getAttribute("aria-label")).toBe(t("palette.title"));
    const input = field();
    expectSameNode(document.activeElement, input);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.placeholder).toBe(t("palette.placeholder"));
    const list = dialog.querySelector("[role=listbox]")!;
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(options().map((option) => option.getAttribute("aria-selected")))
      .toEqual(["true", "false", "false", "false", "false", "false", "false"]);
    expect(activeText()).toBe("ask");
    expect([...dialog.querySelectorAll(".palette-head")].map((head) => head.textContent))
      .toEqual([t("palette.waiting", { count: "1" }), t("palette.sessions"), t("palette.actions")]);
    // Each group is named by its heading.
    for (const group of dialog.querySelectorAll("[role=group]")) {
      expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.className).toBe("palette-head");
    }
  });

  test("a row shows the list row's facts and offers no answer to the agent", () => {
    open();
    const row = options()[0];
    expect(row.dataset.paneId).toBe("ask");
    expect(row.querySelector(".agent-avatar")).not.toBeNull();
    expect(row.querySelector(".palette-status.is-blocked")?.textContent).toBe(t("status.blocked"));
    expect(row.querySelector(".palette-meta")?.textContent).toBe(`${t("status.blocked")} · codex · pairfob · implementation`);
    expect(dialogs()[0].querySelectorAll("button")).toHaveLength(1);
    expect(dialogs()[0].querySelector("button")?.getAttribute("aria-label")).toBe(t("close"));
  });

  test("Enter opens the highlighted session after the dialog is gone, as one jump", async () => {
    open();
    expect(key("Enter").defaultPrevented).toBeTrue();
    await act(async () => { await Promise.resolve(); });
    expect(events).toEqual([]);
    await act(async () => { await pause(10); });
    expect(events).toEqual(["open:ask"]);
    expect(dialogs()).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  test("the arrows move the highlight without moving focus, and wrap", () => {
    open();
    expect(key("ArrowDown").defaultPrevented).toBeTrue();
    expect(activeText()).toBe("build");
    key("ArrowUp");
    key("ArrowUp");
    expect(activeText()).toBe(t("palette.settings"));
    expectSameNode(document.activeElement, field());
    expect(options().filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  test("Enter that commits an input-method candidate is not a choice", async () => {
    open();
    expect(key("Enter", { isComposing: true }).defaultPrevented).toBeFalse();
    expect(key("Enter", {}, 229).defaultPrevented).toBeFalse();
    key("ArrowDown", { isComposing: true });
    expect(activeText()).toBe("ask");
    await act(async () => { await pause(10); });
    expect(dialogs()[0].open).toBeTrue();
    expect(events).toEqual([]);
  });

  test("typing filters, restarts the highlight at the best match, and says when nothing matches", () => {
    open();
    key("ArrowDown");
    type("do");
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining("docs")]);
    expect(activeText()).toBe("docs");
    type("zzz");
    expect(options()).toEqual([]);
    expect(field().hasAttribute("aria-activedescendant")).toBeFalse();
    expect(dialogs()[0].querySelector("[role=status]")?.textContent).toBe(t("palette.none"));
    expect(key("Enter").defaultPrevented).toBeTrue();
    expect(dialogs()[0].open).toBeTrue();
  });

  test("a click runs an action through its port; a disabled one stays put", async () => {
    current = source([agent("build")], { operationBusy: true });
    open();
    const create = options().find((option) => option.textContent === t("palette.create"))!;
    expect(create.getAttribute("aria-disabled")).toBe("true");
    act(() => create.click());
    expect(dialogs()[0].open).toBeTrue();
    const settings = options().find((option) => option.textContent?.startsWith(t("palette.settings")))!;
    await act(async () => { settings.click(); await pause(10); });
    expect(events).toEqual(["run:settings"]);
  });

  test("Escape closes without a jump and returns focus to where it was", async () => {
    open();
    await act(async () => {
      dialogs()[0].dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
      await pause(10);
    });
    expect(dialogs()).toEqual([]);
    expect(events).toEqual([]);
    expectSameNode(document.activeElement, opener);
  });

  test("asking again while it is open returns to the field instead of stacking", () => {
    open();
    opener.focus();
    open();
    expect(dialogs()).toHaveLength(1);
    expectSameNode(document.activeElement, field());
  });

  test("the list follows the herd while the palette is open", () => {
    open();
    key("ArrowDown");
    expect(activeText()).toBe("build");
    current = source([agent("build"), agent("docs", "blocked")]);
    act(() => { for (const listener of [...listeners]) listener(); });
    expect(options()[0].dataset.paneId).toBe("docs");
    // The highlighted row is still listed, so the highlight stays on it.
    expect(activeText()).toBe("build");
  });

  test("Tab walks between the field and Close and never leaves the dialog", () => {
    open();
    const close = dialogs()[0].querySelector<HTMLButtonElement>("button")!;
    // The list is operated from the field, so it is not a stop of its own.
    expect(dialogs()[0].querySelector("[role=listbox]")?.getAttribute("tabindex")).toBe("-1");
    expect(key("Tab").defaultPrevented).toBeTrue();
    expectSameNode(document.activeElement, close);
    const wrap = new happy.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    act(() => { close.dispatchEvent(wrap); });
    expect(wrap.defaultPrevented).toBeTrue();
    expectSameNode(document.activeElement, field());
    key("Tab", { shiftKey: true });
    expectSameNode(document.activeElement, close);
  });

  describe("presentation follows the gesture where the list sits beside the page", () => {
    let release = () => {};
    const press = (pointerType: string) => opener.dispatchEvent(
      new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 30, clientY: 70 }) as unknown as Event);
    const resize = (width: number) => {
      happy.happyDOM.setWindowSize({ width, height: 700 });
      act(() => { window.dispatchEvent(new happy.Event("resize") as unknown as Event); });
    };
    beforeEach(() => {
      happy.happyDOM.setWindowSize({ width: 800, height: 700 });
      release = bindOverlayOrigin(document);
    });
    afterEach(() => {
      release();
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    });

    test("a mouse or ⌘K gets the desk panel below the roomy width; a finger keeps the sheet", async () => {
      press("mouse");
      open();
      expect(dialogs()[0].className).toBe("modal command-palette desk-form");
      await act(async () => { closeTestDialogs(); await pause(); });
      opener.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }) as unknown as Event);
      open();
      expect(dialogs()[0].className).toBe("modal command-palette desk-form");
      await act(async () => { closeTestDialogs(); await pause(); });
      press("touch");
      open();
      expect(dialogs()[0].className).toBe("modal command-palette");
    });

    test("on the phone layout it is the sheet for a mouse too", () => {
      happy.happyDOM.setWindowSize({ width: 600, height: 700 });
      press("mouse");
      open();
      expect(dialogs()[0].className).toBe("modal command-palette");
    });

    test("a window dragged down to the phone layout keeps the query and becomes the sheet", () => {
      press("mouse");
      open();
      type("do");
      resize(760);
      expect(dialogs()[0].className).toBe("modal command-palette desk-form");
      resize(700);
      expect(dialogs()[0].open).toBeTrue();
      expect(dialogs()[0].className).toBe("modal command-palette");
      expect(field().value).toBe("do");
    });
  });

  test("it stays shut without a source, and under another dialog", () => {
    provideCommandPalette(null);
    open();
    expect(dialogs()).toEqual([]);
    provideCommandPalette(ports());
    const other = document.createElement("dialog");
    document.body.append(other);
    other.showModal();
    open();
    expect(dialogs()).toEqual([]);
    other.close();
    other.remove();
    open();
    expect(dialogs()).toHaveLength(1);
  });
});
