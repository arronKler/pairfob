import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { noteKeydown, resetInputMode } from "../../../app/input-mode";
import { setLang, t } from "../../../lib/i18n";
import { provideCommandPalette, type PaletteInput } from "../../command-palette";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { acceptDaemonVersion, checkDaemonRelease } from "../../settings/daemon-update";
import type { HerdActions } from "../actions";
import type { HerdViewModel } from "../model/herd-view";
import { bindOverlayOrigin } from "../../../shared/ui/overlay/origin";
import { RailFoot, RailHead, RailSearch } from "./rail-chrome";

const app = appRoot;
import { DESK_QUERY } from "../../../app/viewport";
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

const realMatchMedia = window.matchMedia;
const realPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
const realFetch = globalThis.fetch;

/**
 * Answer the pointer query the way a mouse (or a finger) would. The rail only
 * exists beside the page, so the desk tier answers yes; every other query keeps
 * its real answer.
 */
function pointer(fine: boolean): void {
  window.matchMedia = ((query: string) => query === FINE_POINTER || query === DESK_QUERY
    ? { matches: query === DESK_QUERY || fine, media: query, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, query)) as typeof window.matchMedia;
}

function platform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

const hint = () => app().querySelector(".rail-search kbd");

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetInputMode();
});

afterEach(() => {
  act(() => unmountReact());
  window.matchMedia = realMatchMedia;
  if (realPlatform) Object.defineProperty(navigator, "platform", realPlatform);
  else delete (navigator as { platform?: string }).platform;
  globalThis.fetch = realFetch;
  provideCommandPalette(null);
  resetInputMode();
  closeTestDialogs();
  act(() => {
    attachLiveSession(null);
    setCredential(null);
  });
});

describe("rail search entry", () => {
  test("it reads as a search field and opens search-and-jump", () => {
    let reads = 0;
    const input = { view: { groups: [], attention: [], create: null, board: { current: false } }, activated: {}, currentPaneId: "" };
    provideCommandPalette({
      read: () => { reads += 1; return input as unknown as PaletteInput; },
      subscribe: () => () => {},
      openSession: () => {},
      runAction: () => {},
    });
    renderReact(<RailSearch />);
    const search = app().querySelector<HTMLButtonElement>(".rail-search")!;
    expect(search.querySelector(".rail-search-text")?.textContent).toBe(t("rail.search"));
    expect(search.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => search.click());
    // The palette takes its snapshot of the herd as it opens.
    expect(reads).toBeGreaterThan(0);
  });

  test("the ⌘K hint needs macOS and a keyboard to press it on", () => {
    platform("MacIntel");
    pointer(true);
    renderReact(<RailSearch />);
    expect(hint()?.textContent).toBe("⌘K");
    expect(hint()?.getAttribute("aria-hidden")).toBe("true");
    expect(app().querySelector(".rail-search")?.getAttribute("aria-keyshortcuts")).toBe("Meta+K");

    // Elsewhere Ctrl+K is the terminal's: no shortcut is offered at all.
    platform("Win32");
    act(() => unmountReact());
    renderReact(<RailSearch />);
    expect(hint()).toBeNull();
    expect(app().querySelector(".rail-search")?.hasAttribute("aria-keyshortcuts")).toBe(false);

    // A touch screen has no key to press until a hardware keyboard proves itself.
    platform("MacIntel");
    pointer(false);
    act(() => unmountReact());
    renderReact(<RailSearch />);
    expect(hint()).toBeNull();
    noteKeydown();
    act(() => unmountReact());
    renderReact(<RailSearch />);
    expect(hint()?.textContent).toBe("⌘K");
  });

  test("a locked search offers no shortcut: ⌘K opens nothing where there is nothing to search", () => {
    platform("MacIntel");
    pointer(true);
    renderReact(<RailSearch disabled />);
    const search = app().querySelector<HTMLButtonElement>(".rail-search")!;
    expect(search.disabled).toBeTrue();
    expect(hint()).toBeNull();
    expect(search.hasAttribute("aria-keyshortcuts")).toBe(false);
    // The field still reads as what it is.
    expect(search.querySelector(".rail-search-text")?.textContent).toBe(t("rail.search"));

    // A tablet that proves its keyboard gains nothing on the locked frame either.
    pointer(false);
    act(() => unmountReact());
    renderReact(<RailSearch disabled />);
    act(() => noteKeydown());
    expect(hint()).toBeNull();
    act(() => unmountReact());
    renderReact(<RailSearch />);
    expect(hint()?.textContent).toBe("⌘K");
  });
});

describe("rail create", () => {
  const view = (disabled = false, tone = "live") => ({
    host: { name: "studio", line: "已连接", tone }, status: { tone, text: "" }, groups: [], listGroup: "flat",
    creatable: !disabled, create: { label: "新建", aria: "新建会话", disabled },
  }) as unknown as HerdViewModel;
  let calls: Array<[string, unknown?]>;
  let release = () => {};
  const actions = {
    createConversation: () => calls.push(["sheet"]),
    openQuickCreate: (anchor?: Element | null) => calls.push(["recents", anchor]),
    openHostMenu() {},
    openGroupModeMenu() {},
  } as unknown as HerdActions;
  const create = () => app().querySelector<HTMLButtonElement>(".rail-create")!;
  const down = (pointerType: string, init: Record<string, unknown> = {}) => create().dispatchEvent(
    new happy.PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType, ...init }) as unknown as Event);

  beforeEach(() => {
    calls = [];
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    release = bindOverlayOrigin(document);
    renderReact(<RailHead view={view()} actions={actions} />);
  });
  afterEach(() => {
    release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  });

  test("a mouse click or the keyboard asks for the recent combinations at the button", () => {
    expect(create().getAttribute("aria-haspopup")).toBe("dialog");
    down("mouse");
    act(() => create().click());
    expect(calls).toEqual([["recents", create()]]);
    calls = [];
    create().focus();
    create().dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    act(() => create().click());
    expect(calls).toEqual([["recents", create()]]);
  });

  test("a right-click asks for the same menu, under the button", () => {
    down("mouse", { button: 2 });
    act(() => { create().dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
    expect(calls).toEqual([["recents", create()]]);
  });

  test("a finger on the same wide rail keeps the phone's pair: a tap opens the sheet, a hold the recents", async () => {
    down("touch");
    create().dispatchEvent(new happy.PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerType: "touch" }) as unknown as Event);
    act(() => create().click());
    expect(calls).toEqual([["sheet"]]);
    calls = [];
    down("touch");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
    expect(calls).toEqual([["recents", create()]]);
  });

  test("the menu follows the rail down to the width it first appears at; on the phone layout a mouse click is the sheet too", () => {
    happy.happyDOM.setWindowSize({ width: 800, height: 900 });
    down("mouse");
    act(() => create().click());
    expect(calls.map(([kind]) => kind)).toEqual(["recents"]);
    calls = [];
    happy.happyDOM.setWindowSize({ width: 600, height: 900 });
    down("mouse");
    act(() => create().click());
    expect(calls).toEqual([["sheet"]]);
  });

  test("a busy computer takes no press", () => {
    act(() => unmountReact());
    renderReact(<RailHead view={view(true)} actions={actions} />);
    expect(create().disabled).toBe(true);
    down("mouse");
    act(() => create().click());
    act(() => { create().dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
    expect(calls).toEqual([]);
  });

  test("the button answers exactly while the list says a session can be started, whatever the status reads", () => {
    // The head has no rule of its own: the list's answer covers Herdr gone, Herdr silent and a list still being read.
    for (const tone of ["live", "off", "warn", "pending"]) {
      act(() => unmountReact());
      renderReact(<RailHead view={view(true, tone)} actions={actions} />);
      expect(create().disabled).toBe(true);
      down("mouse");
      act(() => create().click());
      expect(calls).toEqual([]);
      act(() => unmountReact());
      renderReact(<RailHead view={view(false, tone)} actions={actions} />);
      expect(create().disabled).toBe(false);
    }
  });
});

describe("rail destinations", () => {
  const view = { board: { label: "画板", current: false }, settings: { label: "设置" } } as HerdViewModel;
  const actions = { openBoard() {}, openSettings() {} } as HerdActions;

  test("it is the main navigation landmark the phone tab bar is", () => {
    renderReact(<RailFoot view={view} actions={actions} />);
    const nav = app().querySelector("nav.rail-nav")!;
    expect(nav.getAttribute("aria-label")).toBe(t("tabs.aria"));
    expect([...nav.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["画板", "设置"]);
    expect(nav.querySelector(".rail-nav-dot")).toBeNull();
  });

  test("Settings carries the update dot while the computer needs an update", async () => {
    // Hidden, so the release check schedules no follow-up timer past this test.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    globalThis.fetch = (async () => new Response("0.1.0")) as unknown as typeof fetch;
    renderReact(<RailFoot view={view} actions={actions} />);
    expect(app().querySelector(".rail-nav-dot")).toBeNull();
    await act(async () => {
      setCredential({ daemonId: "rail-foot-update" } as never);
      // A build this old cannot report its version: it always needs the update.
      acceptDaemonVersion({ build: "0.1.0" });
      await checkDaemonRelease(true);
    });
    const settings = [...app().querySelectorAll<HTMLButtonElement>(".rail-nav button")][1];
    expect(settings.querySelector(".rail-nav-dot")?.getAttribute("aria-hidden")).toBe("true");
    expect(settings.querySelector(".sr-only")?.textContent).toBe(t("tabs.updateAria"));
    expect(app().querySelectorAll(".rail-nav-dot")).toHaveLength(1);
  });
});
