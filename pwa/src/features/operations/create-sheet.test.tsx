import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { setLang, t } from "../../lib/i18n";
import type { DirIndex, DirIndexPort } from "../../lib/dir-index";
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

test("failed creation keeps the project and agent; pending creation cannot be sent twice", async () => {
  let calls = 0;
  let finish!: (value: { ok: false; message: string }) => void;
  const { result } = await open({ workspaces: [], initial: NEW_WORKSPACE, initialDir: "/home/me/project",
    onCreate: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await submit();
  expect(button(".create-submit").disabled).toBe(true);
  await submit();
  expect(calls).toBe(1);
  await act(async () => { finish({ ok: false, message: "Agent executable was not found" }); await settle(); });
  expect(sheet().textContent).toContain("Agent executable was not found");
  expect(sheet().textContent).toContain("/home/me/project");
  expect(button(".create-submit").disabled).toBe(false);
  expect(calls).toBe(1);
  await act(async () => { await closeTestDialogs(); });
  expect(await result).toBeNull();
});

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
  test.each([
    { lastKind: null, expected: "agy" },
    { lastKind: "unavailable", expected: "agy" },
    { lastKind: "codex", expected: "codex" },
    { lastKind: "", expected: "" },
  ])("last choice $lastKind selects $expected independently of pins", async ({ lastKind, expected }) => {
    const { result } = await open({ kinds: ["agy", "codex"], lastKind, memory: { ...EMPTY, pinned: ["codex"] } });
    expect(button(".create-kind.on").textContent).toBe(expected || t("create.terminal"));
    await submit();
    expect(await result).toMatchObject({ kind: "tab", agentKind: expected });
  });

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
    expect(sheet().textContent).toContain(t("create.alreadyOpen", { name: "pairfob" }));
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
    // The kind grid and the note that takes its place are both kept; one is folded shut and out of reach.
    const gridFold = sheet().querySelector(".create-kinds")!.closest(".fold")!;
    const noteFold = [...sheet().querySelectorAll(".create-hint")].find((node) => node.textContent === t("create.worktreeTerminal"))!.closest(".fold")!;
    expect([gridFold.hasAttribute("inert"), noteFold.hasAttribute("inert")]).toEqual([false, true]);
    act(() => button(".seg-item", t("create.startWorktree")).click());
    expect([gridFold.classList.contains("is-shut"), gridFold.hasAttribute("inert")]).toEqual([true, true]);
    expect([noteFold.classList.contains("is-shut"), noteFold.hasAttribute("inert")]).toEqual([false, false]);
    type('input[placeholder="' + t("create.branchHint") + '"]', "feat/tabs");
    await submit();
    expect(await result).toEqual({ kind: "worktree", cwd: "~/projects/pairfob", branch: "feat/tabs", base: "", label: "" });
  });

  test("choosing a new workspace opens the block that was there shut, and no field takes focus by itself", async () => {
    await open({ canCreateWorktree: true });
    // Mounted from the start, folded and out of reach: opening it is a change of state, not a new block.
    const dirs = sheet().querySelector(".create-dirs")!;
    const block = dirs.closest(".fold.create-fold")!;
    expect([block.classList.contains("is-shut"), block.hasAttribute("inert")]).toEqual([true, true]);
    const pathLine = sheet().querySelector(".create-path")!.closest(".fold")!;
    expect(pathLine.classList.contains("is-shut")).toBeFalse();
    expect(sheet().querySelector(".create-path")?.textContent).toBe("~/work/herdr-web");
    const held = document.activeElement;
    act(() => button(".create-chip", t("create.newWorkspace")).click());
    expectSameNode(sheet().querySelector(".create-dirs"), dirs);
    expect([block.classList.contains("is-shut"), block.hasAttribute("inert")]).toEqual([false, false]);
    // The line it replaces shuts with its words still in it.
    expect(pathLine.classList.contains("is-shut")).toBeTrue();
    expect(sheet().querySelector(".create-path")?.textContent).toBe("~/work/herdr-web");
    // Nothing was focused by the block opening: a finger gets no keyboard it did not ask for.
    expectSameNode(document.activeElement, held);
    expect(sheet().querySelector("input:focus")).toBeNull();
    // The worktree fields are a block of their own inside it.
    const branch = sheet().querySelector<HTMLInputElement>('input[placeholder="' + t("create.branchHint") + '"]')!;
    const fields = branch.closest(".fold")!;
    expect(fields.hasAttribute("inert")).toBeTrue();
    act(() => button(".seg-item", t("create.startWorktree")).click());
    expectSameNode(sheet().querySelector('input[placeholder="' + t("create.branchHint") + '"]'), branch);
    expect(fields.hasAttribute("inert")).toBeFalse();
    expect(sheet().querySelector("input:focus")).toBeNull();
    act(() => button(".create-chip", "herdr-web").click());
    expect([block.classList.contains("is-shut"), block.hasAttribute("inert")]).toEqual([true, true]);
  });

  test("the path field is there folded, and only the press on its row puts the reader in it", async () => {
    await open({ initial: NEW_WORKSPACE });
    const field = sheet().querySelector<HTMLInputElement>(".create-dirs input")!;
    const fold = field.closest(".fold")!;
    expect([fold.classList.contains("is-shut"), fold.hasAttribute("inert")]).toEqual([true, true]);
    expectDifferentNode(document.activeElement, field);
    act(() => button(".create-dir", t("create.dirOther")).click());
    expectSameNode(sheet().querySelector(".create-dirs input"), field);
    expect([fold.classList.contains("is-shut"), fold.hasAttribute("inert")]).toEqual([false, false]);
    expectSameNode(document.activeElement, field);
    // Choosing a listed directory shuts it again; what was typed is not kept as the path.
    act(() => button(".create-dir", "~/projects/pairfob").click());
    expect(fold.hasAttribute("inert")).toBeTrue();
  });

  test("the full list stands in for the form as a page does: it comes in, and the form comes back with what was chosen", async () => {
    const kinds = ["claude", "codex", "gemini", "amp", "goose", "kimi", "qwen", "pi"];
    await open({ kinds, lastKind: "claude" });
    const form = () => sheet().querySelector<HTMLElement>(".create-swap > .create-sheet-body:not(.is-picking)");
    // Opening the sheet is not a return: the form is still.
    expect(form()?.classList.contains("is-back")).toBeFalse();
    type('.create-field input[type="text"]:not(.is-mono)', "docs");
    act(() => button(".create-kind.is-all").click());
    expect(form()).toBeNull();
    expect(sheet().querySelector(".create-swap > .create-sheet-body.is-picking")).not.toBeNull();
    act(() => button(".kind-pick", "pi").click());
    expect(sheet().querySelector(".is-picking")).toBeNull();
    expect(form()?.classList.contains("is-back")).toBeTrue();
    expect(button(".create-kind.on").textContent).toContain("pi");
    expect(sheet().querySelector<HTMLInputElement>('.create-field input[type="text"]:not(.is-mono)')?.value).toBe("docs");
    // A repaint of the returned form keeps its node, so the return does not play again.
    const returned = form();
    act(() => button(".create-kind", "claude").click());
    expectSameNode(form(), returned);
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

  const index: DirIndex = {
    version: "0123456789abcdef",
    truncated: false,
    entries: [
      { path: "/work/alpha", name: "alpha", parent: "/work", repo: true },
      { path: "/work/pair-app", name: "pair-app", parent: "/work", repo: false },
      { path: "/work/pair-app/docs", name: "docs", parent: "/work/pair-app", repo: false },
    ],
  };

  function dirPort(fetch: DirIndexPort["fetch"]): { port: DirIndexPort; saved: DirIndex[] } {
    const saved: DirIndex[] = [];
    return { saved, port: { cached: () => null, fetch, save: (value) => { saved.push(value); } } };
  }

  test("the directory search row exists only with the capability", async () => {
    await open({ initial: NEW_WORKSPACE });
    expect(sheet().textContent).not.toContain(t("create.dirSearch"));
    act(closeTestDialogs);
    await open({ initial: NEW_WORKSPACE, dirs: dirPort(async () => index).port });
    expect(button(".create-dir", t("create.dirSearch"))).not.toBeNull();
  });

  test("the search lists allowed locations, filters locally and fills the picked path", async () => {
    const { port, saved } = dirPort(async (version) => {
      expect(version).toBe("");
      return index;
    });
    const { result } = await open({ initial: NEW_WORKSPACE, dirs: port, recents: ["/work/old"] });
    await act(async () => { button(".create-dir", t("create.dirSearch")).click(); await settle(); });
    // The empty query shows the roots' top-level directories, then this phone's own.
    expect([...sheet().querySelectorAll(".create-dir-row .create-dir-name")].map((node) => node.textContent))
      .toEqual(["alpha", "pair-app", "old"]);
    expect([...sheet().querySelectorAll(".create-dir-row .create-dir-tag")].map((node) => node.textContent))
      .toEqual([t("create.dirRepoTag")]);
    expect(saved).toEqual([index]);
    // One keystroke filters the local array; nothing else is asked of the computer.
    type(".create-input", "pair");
    expect([...sheet().querySelectorAll(".create-dir-row .create-dir-name")].map((node) => node.textContent))
      .toEqual(["pair-app", "docs"]);
    act(() => button(".create-dir-row", "pair-app").click());
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryWs", { dir: "/work/pair-app", kind: "codex" }));
    // The pick is neither a recent directory nor an open workspace, so the form gives it a row.
    expect(sheet().textContent).toContain(t("create.dirPicked"));
    expect([...sheet().querySelectorAll(".create-dir.is-selected .create-dir-path")].map((node) => node.textContent))
      .toEqual(["/work/pair-app"]);
    await submit();
    expect(await result).toEqual({ kind: "conversation", cwd: "/work/pair-app", agentKind: "codex", label: "" });
  });

  test("a search reopened on a deep pick leads with it instead of the roots' neighbours", async () => {
    const { port } = dirPort(async () => index);
    await open({ initial: NEW_WORKSPACE, dirs: port });
    await act(async () => { button(".create-dir", t("create.dirSearch")).click(); await settle(); });
    type(".create-input", "docs");
    act(() => button(".create-dir-row", "docs").click());
    expect(sheet().querySelector(".create-summary")?.textContent).toBe(t("create.summaryWs", { dir: "/work/pair-app/docs", kind: "codex" }));
    await act(async () => { button(".create-dir", t("create.dirSearch")).click(); await settle(); });
    expect([...sheet().querySelectorAll(".create-dir-row .create-dir-name")].map((node) => node.textContent))
      .toEqual(["docs", "alpha", "pair-app"]);
    expect(sheet().querySelector(".create-dir-row[aria-current] .create-dir-parent")?.textContent).toBe("/work/pair-app");
  });

  test("a failed search says so, keeps the typed path available, and retries", async () => {
    let broken = true;
    const { port } = dirPort(async () => {
      if (broken) throw new Error("offline");
      return index;
    });
    await open({ initial: NEW_WORKSPACE, dirs: port });
    await act(async () => { button(".create-dir", t("create.dirSearch")).click(); await settle(); });
    expect(sheet().querySelector('[role="alert"]')?.textContent).toContain(t("create.dirSearchFailed"));
    broken = false;
    await act(async () => { button(".text-link", t("create.dirSearchRetry")).click(); await settle(); });
    expect(sheet().querySelector('[role="alert"]')).toBeNull();
    expect([...sheet().querySelectorAll(".create-dir-row .create-dir-name")].map((node) => node.textContent))
      .toEqual(["alpha", "pair-app"]);
  });
});
