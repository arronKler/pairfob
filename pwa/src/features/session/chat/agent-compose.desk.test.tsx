import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { noteKeydown, resetInputMode } from "../../../app/input-mode";
import { setLang, t } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { expectSameNode } from "../../../../test-support/node-identity";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../dashboard/catalog-store";
import { applyCapabilities, clearCapabilities } from "../../operations/capabilities-store";
import { setComposeDraft } from "../compose-store";
import { selectPane } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";
import { SendButton } from "../guided/compose-controls";

const { AgentCompose } = await import("./agent-compose");

/**
 * The chat dock's keyboard line. Guided and the complete terminal say what
 * Enter does under their field when a mouse drives them; chat says the same,
 * and stays silent where there is no Shift+Enter to describe.
 */
const hint = () => appRoot().querySelector(".agent-dock .dock-mode-hint")?.textContent ?? null;
const field = () => appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea")!;

/** A pane the chat can prompt, so the idle button is a real send rather than a resting one. */
function canPrompt(): void {
  act(() => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
    replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo", agent: "codex", agent_status: "idle" }],
    });
  });
}

function paint(width: number, height: number): void {
  happy.happyDOM.setWindowSize({ width, height });
  act(() => { renderReact(createElement(AgentCompose)); });
}

let restorePointer: (() => void) | null = null;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  selectPane("p1");
});

afterEach(async () => {
  unmountReact();
  restorePointer?.();
  restorePointer = null;
  resetInputMode();
  await act(async () => { setComposeDraft(""); clearCapabilities(); resetDashboard(); });
  selectPane("");
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("chat dock keyboard hint", () => {
  test("a mouse beside the list reads what Enter and Shift+Enter do", () => {
    paint(1440, 900);
    expect(hint()).toBe("Enter 发送 · Shift+Enter 换行");
    // Under the field, above the over-limit note.
    const line = appRoot().querySelector(".agent-dock .dock-mode")!;
    expect(line.previousElementSibling!.classList.contains("dock-form")).toBeTrue();
  });

  test("it follows the language", () => {
    setLang("en");
    paint(1024, 768);
    expect(hint()).toBe("Enter sends · Shift+Enter adds a line");
  });

  test("a touch tablet's wide layout has no hint", () => {
    restorePointer = emulateTouchDevice();
    paint(1180, 820);
    expect(hint()).toBeNull();
  });

  test("once that tablet's keyboard has proved itself the field says it, with no line added under it", () => {
    restorePointer = emulateTouchDevice();
    act(() => {
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
      replaceAgentsFromSnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo" }],
        tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo", agent: "codex", agent_status: "idle" }],
      });
    });
    paint(1180, 820);
    const field = appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea")!;
    expect(field.placeholder).toBe(t("chat.placeholder"));
    act(() => noteKeydown());
    expectSameNode(appRoot().querySelector(".agent-dock textarea"), field);
    expect(field.placeholder).toBe(`${t("chat.placeholder")} · Enter 发送 · Shift+Enter 换行`);
    expect(hint()).toBeNull();
  });

  test("a field that cannot send says only that, keyboard or not", () => {
    restorePointer = emulateTouchDevice();
    act(() => noteKeydown());
    paint(1180, 820);
    expect(appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea")!.placeholder).toBe(t("chat.cantSendPh"));
  });

  test("the phone dock is unchanged, whatever points at it", () => {
    paint(390, 844);
    expect(hint()).toBeNull();
    expect(appRoot().querySelector(".agent-dock .dock-mode")).toBeNull();
  });
});

describe("the chat dock is one frame", () => {
  test("attach, field and send stand inside the form's own frame", () => {
    paint(1440, 900);
    const form = appRoot().querySelector(".agent-dock form")!;
    expect(form.classList.contains("dock-form")).toBeTrue();
    expect(form.classList.contains("agent-compose")).toBeTrue();
    const fieldBox = form.querySelector(":scope > .compose-field")!;
    expect(fieldBox.querySelector(":scope > textarea")).not.toBeNull();
    const slot = form.querySelector(":scope > .send-slot")!;
    expect(slot.querySelector(":scope > .send-btn")).not.toBeNull();
  });

  test("the field rests at the height of a mouse's two-row frame", () => {
    paint(1440, 900);
    expect(field().style.height).toBe("36px");
  });

  test("a finger's one-row frame gives the field its 44px resting height", () => {
    restorePointer = emulateTouchDevice();
    paint(390, 844);
    expect(field().style.height).toBe("44px");
  });
});

describe("the idle send is a round arrow", () => {
  test("under a mouse it is the arrow, with the send aria name", () => {
    canPrompt();
    paint(1440, 900);
    act(() => { setComposeDraft("hello"); });
    const button = appRoot().querySelector<HTMLButtonElement>(".agent-dock .send-btn")!;
    expect(button.dataset.sendKind).toBe("send");
    expect(button.getAttribute("aria-label")).toBe(t("compose.sendEnterAria"));
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });

  test("a finger's button is the same arrow", () => {
    restorePointer = emulateTouchDevice();
    canPrompt();
    paint(390, 844);
    act(() => { setComposeDraft("hello"); });
    const button = appRoot().querySelector<HTMLButtonElement>(".agent-dock .send-btn")!;
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });

  test("every compact kind wears its circle with no word on it", () => {
    for (const [kind, aria] of [["stop", t("compose2.stopAria")], ["stopping", t("compose2.stoppingAria")], ["force", t("compose2.forceAria")]] as const) {
      act(() => {
        renderReact(createElement(SendButton, {
          kind, percent: 0, className: "send-btn", compact: true,
          onSend: () => undefined, stopTarget: null, longPressStops: false,
        }));
      });
      const button = appRoot().querySelector<HTMLButtonElement>(".send-btn")!;
      // The face is a mark in the send's circle, named by its aria label.
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg, .spinner")).not.toBeNull();
      expect(button.getAttribute("aria-label")).toBe(aria);
      act(unmountReact);
    }
  });

  test("a caller that does not ask for compact keeps its word", () => {
    act(() => {
      renderReact(createElement(SendButton, {
        kind: "send", percent: 0, className: "send-btn",
        onSend: () => undefined, stopTarget: null, longPressStops: false,
      }));
    });
    const button = appRoot().querySelector<HTMLButtonElement>(".send-btn")!;
    expect(button.textContent).toBe(t("compose.send"));
    expect(button.getAttribute("aria-label")).toBe(t("compose.sendEnterAria"));
  });
});
