import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { setLang, t } from "../../lib/i18n";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { loadCreateMemory, type CreateMemory } from "./create-memory";
import { askCreate, NEW_WORKSPACE, type CreateRequest, type CreateSheetInput } from "./create-sheet";

const EMPTY: CreateMemory = { pinned: [], uses: {}, lastUsed: {}, recents: [], dirs: [] };

function input(overrides: Partial<CreateSheetInput> = {}): CreateSheetInput {
  return {
    host: "studio",
    workspaces: [
      { id: "w1", label: "pairfob", path: "~/projects/pairfob" },
      { id: "w2", label: "herdr-web", path: "~/work/herdr-web" },
    ],
    initial: "w2",
    kinds: ["claude", "codex"],
    memory: EMPTY,
    lastKind: "codex",
    canCreateTab: true,
    canCreateWorkspace: true,
    canCreateWorktree: false,
    ...overrides,
  };
}

const settle = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const sheet = () => document.querySelector<HTMLDialogElement>("dialog.create-sheet")!;

function button(selector: string, text?: string): HTMLButtonElement {
  const found = [...sheet().querySelectorAll<HTMLButtonElement>(selector)]
    .find((node) => text === undefined || node.textContent?.includes(text));
  if (!found) throw new Error(`missing ${selector} ${text ?? ""}: ${sheet().textContent?.slice(0, 200)}`);
  return found;
}

function type(selector: string, value: string): void {
  const field = sheet().querySelector<HTMLInputElement>(selector)!;
  act(() => {
    // Controlled inputs: set through the element's own prototype so React's
    // value tracker sees a change. Under happy-dom React reads a focused text
    // field's change on key events, so focus and follow the input with a keyup.
    field.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    field.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

/** The sheet's answer, wrapped so awaiting the open does not wait for a submit. */
async function open(options: Partial<CreateSheetInput> = {}): Promise<{ result: Promise<CreateRequest | null> }> {
  let result!: Promise<CreateRequest | null>;
  await act(async () => {
    result = askCreate(input(options));
    await settle();
  });
  return { result };
}

async function submit(): Promise<void> {
  await act(async () => {
    button(".create-submit").click();
    await settle();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  localStorage.clear();
  setLang("zh");
});

afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    await settle();
  });
});

describe("create sheet", () => {
  test("opens on the entry's workspace with the last kind, says what will happen, and returns a tab", async () => {
    const { result } = await open();
    expect(sheet().querySelector(".modal-title")?.textContent).toBe(t("create.title"));
    expect(button(".create-chip.on").textContent).toBe("herdr-web");
    expect(sheet().querySelector(".create-path")?.textContent).toBe("~/work/herdr-web");
    expect(button(".create-kind.on").textContent).toContain("codex");
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryTab", { workspace: "herdr-web", kind: "codex" }));
    act(() => button(".create-kind", "claude").click());
    act(() => button(".create-chip", "pairfob").click());
    type(".create-field input", "  review  ");
    await submit();
    expect(await result).toEqual({ kind: "tab", workspaceId: "w1", agentKind: "claude", label: "review" });
  });

  test("Enter in a text field submits the desk form; the sheet leaves Return to the on-screen keyboard", async () => {
    const enter = (init: Record<string, unknown> = {}) => {
      const event = new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
      act(() => { sheet().querySelector(".create-field input")!.dispatchEvent(event); });
      return event;
    };
    const sheetOpen = await open();
    expect(sheet().classList.contains("desk-form")).toBeFalse();
    expect(enter().defaultPrevented).toBeFalse();
    expect(sheet().open).toBeTrue();
    await act(async () => { closeTestDialogs(); await settle(); });
    expect(await sheetOpen.result).toBeNull();

    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    const release = bindOverlayOrigin(document);
    document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    try {
      const { result } = await open();
      expect(sheet().classList.contains("desk-form")).toBeTrue();
      type(".create-field input", "review");
      // An IME confirming its candidate is not the form's Enter.
      expect(enter({ isComposing: true }).defaultPrevented).toBeFalse();
      expect(sheet().open).toBeTrue();
      // A button that is not a choice keeps Enter as its own press.
      const cancel = new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
      act(() => { button(".desk-cancel").dispatchEvent(cancel); });
      expect(cancel.defaultPrevented).toBeFalse();
      await act(async () => { expect(enter().defaultPrevented).toBeTrue(); await settle(); });
      expect(await result).toEqual({ kind: "tab", workspaceId: "w2", agentKind: "codex", label: "review" });
    } finally {
      release();
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    }
  });

  test("Enter on a choice chooses it and submits the desk form with it; in the sheet it is the chip's own press", async () => {
    const enterOn = (target: HTMLElement) => {
      const event = new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    const sheetOpen = await open();
    expect(enterOn(button(".create-chip", "pairfob")).defaultPrevented).toBeFalse();
    expect(sheet().querySelector(".desk-cancel")).toBeNull();
    await act(async () => { closeTestDialogs(); await settle(); });
    expect(await sheetOpen.result).toBeNull();

    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    const release = bindOverlayOrigin(document);
    document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    try {
      // A workspace chip that is not the chosen one, then the form goes with it.
      const first = await open();
      expect(button(".create-chip.on").textContent).toBe("herdr-web");
      await act(async () => { expect(enterOn(button(".create-chip", "pairfob")).defaultPrevented).toBeTrue(); await settle(); });
      expect(await first.result).toEqual({ kind: "tab", workspaceId: "w1", agentKind: "codex", label: "" });
      // A kind tile is a choice too; the way into the full list is not.
      const second = await open({ kinds: ["claude", "codex", "gemini", "amp", "goose", "kimi", "qwen", "pi"], lastKind: "codex" });
      expect(enterOn(button(".create-kind.is-all")).defaultPrevented).toBeFalse();
      await act(async () => { expect(enterOn(button(".create-kind", "claude")).defaultPrevented).toBeTrue(); await settle(); });
      expect(await second.result).toEqual({ kind: "tab", workspaceId: "w2", agentKind: "claude", label: "" });
    } finally {
      release();
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    }
  });

  test("the desk form's footer is Cancel, then the action; Cancel dismisses with nothing", async () => {
    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    const release = bindOverlayOrigin(document);
    document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    try {
      const { result } = await open();
      const actions = [...sheet().querySelectorAll(".create-footer button")];
      expect(actions.map((node) => node.textContent)).toEqual([t("cancel"), t("create.submit")]);
      await act(async () => { button(".desk-cancel").click(); await settle(); });
      expect(await result).toBeNull();
    } finally {
      release();
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    }
  });

  test("a terminal is always offered and carries no agent kind", async () => {
    const { result } = await open();
    act(() => button(".create-kind", t("create.terminal")).click());
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryTab", { workspace: "herdr-web", kind: t("create.terminal") }));
    await submit();
    expect(await result).toEqual({ kind: "tab", workspaceId: "w2", agentKind: "", label: "" });
  });

  test("a new workspace needs a directory, and a typed path becomes a conversation", async () => {
    const { result } = await open({ memory: { ...EMPTY, dirs: ["~/work/herdr-cli"] } });
    act(() => button(".create-chip", t("create.newWorkspace")).click());
    expect([...sheet().querySelectorAll(".create-dir-path")].map((node) => node.textContent))
      .toEqual(["~/work/herdr-cli", "~/projects/pairfob", "~/work/herdr-web", t("create.dirOther")]);
    button(".create-submit").focus();
    await submit();
    expect(sheet().querySelector('[role="alert"]')?.textContent).toBe(t("create.needDir"));
    // A finger's tap left no keyboard position: the refusal moves nothing (and raises no keyboard).
    expectSameNode(document.activeElement, button(".create-submit"));
    // Under a mouse or the keyboard the reader is put in the chooser the message is about.
    const release = bindOverlayOrigin(document);
    try {
      document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Tab", bubbles: true }) as unknown as Event);
      await submit();
      expectSameNode(document.activeElement, button(".create-dir", "~/work/herdr-cli"));
      act(() => button(".create-dir", t("create.dirOther")).click());
      // With a path being typed, an empty one is refused in that field.
      button(".create-submit").focus();
      await submit();
      expectSameNode(document.activeElement, sheet().querySelector(".create-dirs input"));
    } finally { release(); }
    type(".create-dirs input", "~/work/newapp");
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryWs", { dir: "~/work/newapp", kind: "codex" }));
    await submit();
    expect(await result).toEqual({ kind: "conversation", cwd: "~/work/newapp", agentKind: "codex", label: "" });
  });

  test("choosing an open workspace's directory offers, and creates, a tab there instead", async () => {
    const { result } = await open({ initial: NEW_WORKSPACE });
    act(() => button(".create-dir", "~/projects/pairfob").click());
    expect(sheet().querySelector(".create-hint")?.textContent).toContain(t("create.alreadyOpen", { name: "pairfob" }));
    // The summary names what the button will do, not a new workspace.
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryTab", { workspace: "pairfob", kind: "codex" }));
    await submit();
    expect(await result).toEqual({ kind: "tab", workspaceId: "w1", agentKind: "codex", label: "" });
  });

  test("a new worktree is offered only with the capability and opens with a terminal", async () => {
    await open({ initial: NEW_WORKSPACE });
    expect(sheet().querySelector(".create-seg")).toBeNull();
    act(closeTestDialogs);
    const { result } = await open({ initial: NEW_WORKSPACE, canCreateWorktree: true });
    act(() => button(".create-dir", "~/projects/pairfob").click());
    act(() => button(".seg-item", t("create.startWorktree")).click());
    expect(sheet().querySelector(".create-kinds")).toBeNull();
    expect(sheet().textContent).toContain(t("create.worktreeTerminal"));
    type('input[placeholder="' + t("create.branchHint") + '"]', "feat/tabs");
    await submit();
    expect(await result).toEqual({ kind: "worktree", cwd: "~/projects/pairfob", branch: "feat/tabs", base: "", label: "" });
  });

  test("without create_tab the sheet only creates workspaces", async () => {
    await open({ canCreateTab: false });
    expect([...sheet().querySelectorAll(".create-chip")].map((node) => node.textContent)).toEqual([t("create.newWorkspace")]);
    expect(button(".create-chip.on").textContent).toBe(t("create.newWorkspace"));
  });

  test("many kinds: six in the grid, the rest behind the full list, where a pick and a pin both stick", async () => {
    const kinds = ["claude", "codex", "gemini", "amp", "goose", "kimi", "qwen", "pi"];
    const { result } = await open({ kinds, lastKind: "claude", memory: { ...loadCreateMemory(), uses: { claude: 5, codex: 4, gemini: 2, amp: 1 } } });
    // Two rows of four: six kinds, the terminal and the full list; icon and name only.
    expect([...sheet().querySelectorAll(".create-kind-name")].map((node) => node.textContent))
      .toEqual(["claude", "codex", "gemini", "amp", "goose", "kimi", t("create.terminal"), t("create.all", { n: "8" })]);
    expect(sheet().querySelector(".create-kind-sub")).toBeNull();
    act(() => button(".create-kind.is-all").click());
    expect([...sheet().querySelectorAll(".kind-pick-name")].map((node) => node.textContent))
      .toEqual(["claude", "codex", "gemini", "amp", "goose", "kimi", "pi", "qwen"]);
    // Claude and Codex arrive starred on a phone that never touched a star.
    expect([...sheet().querySelectorAll(".kind-row:has(.kind-star.is-on) .kind-pick-name")].map((node) => node.textContent))
      .toEqual(["claude", "codex"]);
    const geminiStar = [...sheet().querySelectorAll(".kind-row")]
      .find((row) => row.querySelector(".kind-pick-name")?.textContent === "gemini")!.querySelector<HTMLButtonElement>(".kind-star")!;
    act(() => geminiStar.click());
    expect(loadCreateMemory().pinned).toEqual(["claude", "codex", "gemini"]);
    act(() => button(".kind-pick", "pi").click());
    expect([...sheet().querySelectorAll(".create-kind-name")].slice(0, 6).map((node) => node.textContent))
      .toEqual(["claude", "codex", "gemini", "amp", "goose", "pi"]);
    expect(button(".create-kind.on").textContent).toContain("pi");
    await submit();
    expect((await result as Extract<CreateRequest, { kind: "tab" }>).agentKind).toBe("pi");
  });
});
