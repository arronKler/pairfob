import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { MenuItem, MenuRadio, showActionSheet } from "./action-sheet";
import { MenuRow } from "./menu-controls";
import { useSheetNav } from "./sheet-stack";

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); });
afterEach(async () => { await act(async () => { closeTestDialogs(); await pause(); }); });

test("sheet owns accessible heading, stable drag siblings and the first enabled action focus", () => {
  act(() => showActionSheet("Actions", modal => <>
    <MenuItem modal={modal} disabled>Disabled</MenuItem><MenuItem modal={modal}>Cancel</MenuItem>
  </>));
  const dialog = sheet();
  expect(dialog.open).toBeTrue();
  expect(dialog.hasAttribute("data-react-modal")).toBeTrue();
  expect(dialog.querySelector("h2")?.id).toBe(dialog.getAttribute("aria-labelledby"));
  expect([...dialog.querySelector("form")!.children].map(node => node.className)).toEqual(["sheet-grab", "sheet-head", "sheet-body"]);
  expect(document.activeElement?.textContent).toBe("Cancel");
});

test("picked action runs once on the next task after native close and React removal", async () => {
  const observations: boolean[] = [];
  act(() => showActionSheet("Actions", modal => <MenuItem modal={modal} action={() => {
    observations.push(document.querySelector("dialog.sheet") === null);
  }}>Run</MenuItem>));
  const run = sheet().querySelector<HTMLButtonElement>(".menu-item")!;
  await act(async () => { run.click(); run.click(); await Promise.resolve(); });
  expect(observations).toEqual([]);
  await act(async () => { await pause(10); });
  expect(observations).toEqual([true]);
});

test("backdrop ignores the opening click, while Escape remains immediately available", async () => {
  act(() => showActionSheet("Actions", modal => <MenuItem modal={modal}>Cancel</MenuItem>));
  const dialog = sheet();
  act(() => dialog.dispatchEvent(new happy.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(dialog.open).toBeTrue();
  await act(async () => {
    dialog.dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
    await Promise.resolve();
  });
  expect(document.querySelector("dialog.sheet")).toBeNull();
});

test("a later backdrop click dismisses and restores the triggering control", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  act(() => showActionSheet("Actions", modal => <MenuItem modal={modal}>Cancel</MenuItem>));
  await act(async () => { await pause(410); sheet().click(); await Promise.resolve(); });
  expect(document.querySelector("dialog.sheet")).toBeNull();
  expectSameNode(document.activeElement, trigger);
  trigger.remove();
});

test("replacing a sheet retires its listeners without moving focus out of the replacement", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  act(() => showActionSheet("First", modal => <MenuItem modal={modal}>Old action</MenuItem>));
  const first = sheet();
  await act(async () => {
    showActionSheet("Second", modal => <MenuItem modal={modal}>New action</MenuItem>);
    await Promise.resolve();
  });
  expect(document.querySelectorAll("dialog.sheet").length).toBe(1);
  expect(first.isConnected).toBeFalse();
  expect(document.activeElement?.textContent).toBe("New action");
  trigger.remove();
});

test("selected radio and disabled actions leave the sheet open without dispatch", () => {
  let calls = 0;
  act(() => showActionSheet("Modes", modal => <>
    <MenuRadio modal={modal} label="Guided" aria="Guided mode" selected action={() => { calls++; }} />
    <MenuItem modal={modal} disabled action={() => { calls++; }}>Unavailable</MenuItem>
  </>));
  act(() => { sheet().querySelector<HTMLButtonElement>("[role=radio]")!.click(); sheet().querySelector<HTMLButtonElement>(".menu-item")!.click(); });
  expect(sheet().open).toBeTrue();
  expect(calls).toBe(0);
});

function PushRow({ onPage }: { onPage: () => void }) {
  const nav = useSheetNav()!;
  return <MenuRow label="Details" next onClick={() => nav.push({ key: "details", title: "Details",
    render: () => <button type="button" onClick={onPage}>Inside</button> })} />;
}

test("a pushed page replaces the body inside the same dialog and Back or Escape returns", async () => {
  let inside = 0;
  act(() => showActionSheet("Actions", () => <PushRow onPage={() => { inside++; }} />, { subtitle: "api-server" }));
  const dialog = sheet();
  expect(dialog.querySelector(".sheet-subtitle")?.textContent).toBe("api-server");
  act(() => dialog.querySelector<HTMLButtonElement>(".menu-row")!.click());
  expectSameNode(sheet(), dialog);
  expect(dialog.querySelector("h2")?.textContent).toBe("Details");
  expect(dialog.querySelector(".sheet-subtitle")).toBeNull();
  expect(document.activeElement?.textContent).toBe("Inside");
  act(() => dialog.querySelector<HTMLButtonElement>(".sheet-back")!.click());
  expect(dialog.querySelector("h2")?.textContent).toBe("Actions");
  expect(dialog.querySelector(".sheet-back")).toBeNull();
  act(() => dialog.querySelector<HTMLButtonElement>(".menu-row")!.click());
  await act(async () => {
    dialog.dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
    await Promise.resolve();
  });
  expect(dialog.open).toBeTrue();
  expect(dialog.querySelector("h2")?.textContent).toBe("Actions");
  expect(inside).toBe(0);
});

test("a staying radio applies in place and an expandable handle toggles the taller height", () => {
  let picked = "";
  act(() => showActionSheet("Width", modal => <>
    <MenuRadio modal={modal} stay label="Fit" aria="Fit" selected={false} action={() => { picked = "fit"; }} />
  </>, { expandable: true }));
  const dialog = sheet();
  act(() => dialog.querySelector<HTMLButtonElement>("[role=radio]")!.click());
  expect(picked).toBe("fit");
  expect(dialog.open).toBeTrue();
  const handle = dialog.querySelector<HTMLButtonElement>("button.sheet-grab")!;
  expect(dialog.classList.contains("is-expandable")).toBeTrue();
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  act(() => handle.click());
  expect(dialog.classList.contains("is-expanded")).toBeTrue();
  expect(handle.getAttribute("aria-expanded")).toBe("true");
});
