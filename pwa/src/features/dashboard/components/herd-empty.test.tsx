import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { setLang, t } from "../../../lib/i18n";
import type { HerdActions } from "../actions";
import { herdEmptyView } from "../model/herd-view";
import { HerdEmpty } from "./herd-empty";

/**
 * The empty list on the phone page and in the desk rail. The page is the whole
 * screen and says the invitation; the rail stands beside a column that says it
 * (`app/layout/desk-empty.tsx`) and keeps only what is the list's own.
 */
const app = appRoot;
let calls: string[] = [];
const actions = {
  runEmptyAction: (kind: string) => calls.push(`empty:${kind}`),
  createInDir: (dir: string) => calls.push(`createIn:${dir}`),
} as unknown as HerdActions;

const input = { runtimeKind: "herdr", connected: true, createConversation: true, networkOnline: true, operationBusy: false,
  hostName: "studio", recentDirs: ["~/work/pairfob", "~/work/site"] };

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  calls = [];
});
afterEach(() => { act(() => unmountReact()); });

test("the phone page invites: the glyph, the computer's heading, the explanation and the one create button", () => {
  act(() => renderReact(<HerdEmpty empty={herdEmptyView(input)} actions={actions} />));
  const empty = app().querySelector(".herd-empty")!;
  expect(empty.className).toBe("herd-empty");
  expect([...empty.children].map((node) => node.className)).toEqual(
    ["herd-empty-glyph", "herd-empty-title", "herd-empty-sub", "herd-empty-actions", "herd-empty-recent"]);
  expect(empty.querySelector(".herd-empty-title")?.textContent).toBe(t("empty.hostTitle", { host: "studio" }));
  expect(empty.querySelectorAll(".btn-primary")).toHaveLength(1);
});

test("the desk rail only notes that the list is empty: no second heading, no second create button", () => {
  act(() => renderReact(<HerdEmpty empty={herdEmptyView(input)} actions={actions} beside />));
  const empty = app().querySelector(".herd-empty")!;
  expect(empty.className).toBe("herd-empty is-beside");
  expect([...empty.children].map((node) => node.className)).toEqual(["herd-empty-note", "herd-empty-recent"]);
  const note = empty.querySelector("h2")!;
  expect(note.textContent).toBe(t("empty.noneTitle"));
  expect(empty.getAttribute("aria-labelledby")).toBe(note.id);
  expect(empty.querySelector(".btn, .herd-empty-glyph, .herd-empty-sub")).toBeNull();
  // The directories used before are the list's own shortcuts and stay.
  act(() => [...empty.querySelectorAll<HTMLButtonElement>(".herd-empty-dir")][1].click());
  expect(calls).toEqual(["createIn:~/work/site"]);
});

test("without remote create the rail notes the same; the command to run is said beside it", () => {
  act(() => renderReact(<HerdEmpty empty={herdEmptyView({ ...input, createConversation: false })} actions={actions} beside />));
  const empty = app().querySelector(".herd-empty.is-beside")!;
  expect([...empty.children].map((node) => node.className)).toEqual(["herd-empty-note"]);
  expect(empty.textContent).toBe(t("empty.noneTitle"));
});

test("Herdr gone or silent: the page explains in its panel, the rail only names it", () => {
  for (const [runtimeKind, kind, title, command] of [["offline", "exited", "empty.exitedTitle", "pairfob doctor"], ["", "unverifiable", "empty.unverifiedTitle", null]] as const) {
    act(() => renderReact(<HerdEmpty empty={herdEmptyView({ ...input, runtimeKind })} actions={actions} />));
    const panel = app().querySelector(`.herd-empty-panel.is-${kind}`)!;
    expect(panel.querySelector(".herd-empty-panel-title")?.textContent).toBe(t(title));
    expect(panel.querySelector("code")?.textContent ?? null).toBe(command);
    expect(panel.querySelectorAll(".herd-empty-action").length).toBeGreaterThan(0);
    act(() => renderReact(<HerdEmpty empty={herdEmptyView({ ...input, runtimeKind })} actions={actions} beside />));
    expect(app().querySelector(".herd-empty-panel")).toBeNull();
    const note = app().querySelector(".herd-empty.is-beside")!;
    expect([...note.children].map((node) => `${node.tagName.toLowerCase()}.${node.className}`)).toEqual(["h2.herd-empty-note"]);
    expect(note.textContent).toBe(t(title));
    expect(note.querySelector("button, code")).toBeNull();
  }
});

test("offline or reconnecting: the page notes what follows above still rows, the rail keeps the rows alone", () => {
  for (const overrides of [{ networkOnline: false, connected: false }, { connected: false }]) {
    act(() => renderReact(<HerdEmpty empty={herdEmptyView({ ...input, ...overrides })} actions={actions} />));
    expect(app().querySelector("p.herd-empty-note")?.getAttribute("role")).toBe("status");
    expect(app().querySelector(".herd-skeleton.is-still")).not.toBeNull();
    act(() => renderReact(<HerdEmpty empty={herdEmptyView({ ...input, ...overrides })} actions={actions} beside />));
    expect(app().querySelector(".herd-empty-note")).toBeNull();
    expect(app().querySelector(".herd-skeleton.is-still")).not.toBeNull();
  }
});
