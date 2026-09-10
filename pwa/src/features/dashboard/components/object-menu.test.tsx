import { resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { AgentCard } from "../../../lib/ranking";
import { setLang, t } from "../../../lib/i18n";
import { openObjectMenu, type ObjectMenuRunner } from "./object-menu";
import type { ObjectMenuKind, ObjectMenuModel } from "../model/object-menu";

const agent: AgentCard = {
  paneId: "p2", paneLabel: "Target", agent: "codex", status: "idle", workspaceId: "w2",
  workspaceLabel: "Two", tabId: "t2", cwd: "/two/project",
};

function model(items: Array<{ kind: ObjectMenuKind; label: string; danger?: boolean }>): ObjectMenuModel {
  return {
    title: "Target",
    facts: [
      { key: t("detail.status"), value: t("status.idle") },
      { key: t("detail.path"), value: "/two/project", kind: "path" },
    ],
    items,
  };
}

let ran: Array<{ kind: ObjectMenuKind; paneId: string }> = [];
const run: ObjectMenuRunner = (kind, target) => {
  ran.push({ kind, paneId: target.paneId });
};

const settle = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function item(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(".sheet-body button")]
    .find((node) => node.textContent === label);
  if (!found) throw new Error(`missing menu item ${label}`);
  return found;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  ran = [];
});

afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    await settle();
  });
});

describe("object menu sheet", () => {
  test("facts stay above the actions and keep the path styling", () => {
    act(() => openObjectMenu(model([{ kind: "pin", label: t("menu.pin") }]), agent, run));
    const body = document.querySelector(".sheet-body")!;
    expect(body.firstElementChild?.className).toBe("sheet-facts");
    expect([...body.querySelectorAll(".sheet-fact-key")].map((node) => node.textContent))
      .toEqual([t("detail.status"), t("detail.path")]);
    expect(body.querySelector(".sheet-fact-path")?.textContent).toBe("/two/project");
    expect(body.querySelector(".sheet-fact-val")?.classList.contains("sheet-fact-path")).toBe(false);
    expect(document.querySelector(".modal-title")?.textContent).toBe("Target");
  });

  test("a model without facts renders only the actions", () => {
    act(() => openObjectMenu({ title: "Two", facts: [], items: [{ kind: "renameWorkspace", label: t("menu.renameWorkspace") }] }, agent, run));
    expect(document.querySelector(".sheet-facts")).toBeNull();
    expect([...document.querySelectorAll(".sheet-body button")].map((node) => node.textContent))
      .toEqual([t("menu.renameWorkspace")]);
  });

  test("items keep the projected order and danger styling", () => {
    act(() => openObjectMenu(model([
      { kind: "pin", label: t("menu.pin") },
      { kind: "renamePane", label: t("menu.renamePane") },
      { kind: "closePane", label: t("op.closePane"), danger: true },
    ]), agent, run));
    const items = [...document.querySelectorAll<HTMLButtonElement>(".sheet-body .menu-item")];
    expect(items.map((node) => node.textContent)).toEqual([t("menu.pin"), t("menu.renamePane"), t("op.closePane")]);
    expect(items.map((node) => node.classList.contains("menu-danger"))).toEqual([false, false, true]);
  });

  test("an action closes the sheet and routes its kind and card to the runner exactly once", async () => {
    act(() => openObjectMenu(model([
      { kind: "pin", label: t("menu.pin") },
      { kind: "closePane", label: t("op.closePane"), danger: true },
    ]), agent, run));
    await act(async () => {
      item(t("op.closePane")).click();
      await settle();
    });
    expect(ran).toEqual([{ kind: "closePane", paneId: "p2" }]);
    expect(document.querySelector("dialog.sheet")).toBeNull();
  });

  test("dismissing runs nothing", async () => {
    act(() => openObjectMenu(model([{ kind: "pin", label: t("menu.pin") }]), agent, run));
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".sheet-close")!.click();
      await settle();
    });
    expect(ran).toEqual([]);
    expect(document.querySelector("dialog.sheet")).toBeNull();
  });
});
