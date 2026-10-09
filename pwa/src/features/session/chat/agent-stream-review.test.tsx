import { expectSameNode } from "../../../../test-support/node-identity";
import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { setAgentChat, selectPane } from "../session-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { resetChatDetails } from "./details";
import { readDetailsState, type AgentEmptySpec } from "./agent-chat-stream";
import { AgentDetails } from "./agent-details";
import { AgentStream } from "./agent-stream";

const empty: AgentEmptySpec = { kind: "empty", title: "No history" };
const user: AgentTraceItem = { type: "user", text: "Inspect this" };
const thinking: AgentTraceItem = { type: "thinking", text: "Start by checking" };

beforeEach(async () => {
  await resetTestDOM();
  clearAgentTraceCache();
  resetChatDetails();
  setLang("zh");
  setAgentChat(true);
  selectPane("review-pane");
});
afterEach(() => {
  act(unmountReact);
  clearAgentTraceCache();
  attachLiveSession(null);
  setAgentChat(false);
  selectPane("");
});

function toggle(card: HTMLDetailsElement, open: boolean): void {
  act(() => {
    card.open = open;
  });
}
function current(): HTMLElement { return appRoot().querySelector<HTMLElement>(".agent-stream")!; }
function card(prompt: string, nth = 0): HTMLDetailsElement {
  const found = [...appRoot().querySelectorAll<HTMLDetailsElement>("details.work-card")]
    .filter(node => node.previousElementSibling?.textContent === prompt);
  if (!found[nth]) throw new Error(`Missing card after ${prompt}`);
  return found[nth];
}
function paint(items: AgentTraceItem[], working = true): void {
  const kept = readDetailsState(appRoot().querySelector(".agent-stream"));
  act(() => renderReact(<AgentStream items={items} working={working} empty={empty} kept={kept} />));
}
async function drain(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

test("a different turn does not inherit the preceding card's manual expansion", () => {
  const original: AgentTraceItem[] = [user, { type: "tool", name: "Read", input: "first.txt", output: "done" }, { type: "assistant", text: "A" }];
  const replacement: AgentTraceItem[] = [user, { type: "tool", name: "Read", input: "second.txt", output: "done" }, { type: "assistant", text: "B" }];
  paint(original, false);
  const previous = card("Inspect this");
  toggle(previous, true);
  const oldKey = previous.dataset.key;
  paint(replacement, false);
  const next = card("Inspect this");
  expect(next.dataset.key === oldKey).toBeFalse();
  expect(next.open).toBeFalse();
  expect(next.dataset.user).toBeUndefined();
});

test("prepending a repeated prompt preserves only the matching card choice", () => {
  const turn = (name: string): AgentTraceItem[] => [
    { type: "user", text: "Again" }, { type: "thinking", text: `Check ${name}` },
    { type: "tool", name, output: "done" }, { type: "assistant", text: `Result ${name}` },
  ];
  const initial = [...turn("Tool A"), ...turn("Tool B")];
  paint(initial, false);
  toggle(card("Again", 1), true);
  const prepended = [...turn("Tool Older"), ...initial];
  paint(prepended, false);
  expect([0, 1, 2].map(index => card("Again", index).open)).toEqual([false, false, true]);
});

test("prepending a distinct turn restores an open card through its captured stable key", () => {
  const initial: AgentTraceItem[] = [user, thinking, { type: "tool", name: "Read", output: "done" },
    { type: "assistant", text: "Finished" }];
  paint(initial, false);
  toggle(card("Inspect this"), true);
  paint([{ type: "user", text: "Older" }, { type: "assistant", text: "Old answer" }, ...initial], false);
  expect(card("Inspect this").open).toBeTrue();
});

test("a queued lazy-open notification is cancelled when its details unmount before the microtask", async () => {
  const requests: string[] = [];
  renderReact(<AgentDetails traceKey="pending" className="agent-step" auto
    onOpen={source => requests.push(source)}><summary>Pending</summary></AgentDetails>);
  // The details really mounted (auto keeps it open) before the same-task
  // retirement; the queued lazy-open microtask is what the unmount cancels.
  const details = appRoot().querySelector<HTMLDetailsElement>(".agent-step");
  expect(details).not.toBeNull();
  expect(details!.open).toBeTrue();
  unmountReact();
  await drain();
  expect(requests).toEqual([]);
});

function streamShape(stream: HTMLElement) {
  return {
    busy: stream.getAttribute("aria-busy"),
    role: stream.getAttribute("role"),
    outer: [...stream.querySelector(".agent-stream-inner")!.children].map(node => ({
      tag: node.tagName, class: node.className, text: node.textContent, role: node.getAttribute("role"),
    })),
    details: [...stream.querySelectorAll<HTMLDetailsElement>("details")].map(card => ({
      key: card.dataset.key, class: card.className, open: card.open, auto: card.dataset.autoOpen,
    })),
  };
}

test("empty/loading/working/error states retain accessible status and busy contracts", () => {
  for (const kind of ["empty", "loading", "working", "error"] as const) {
    act(() => renderReact(<AgentStream items={[]} working={false} busy={kind === "loading"}
      empty={{ kind, title: "Title", sub: "Description" }} />));
    expect(streamShape(current())).toEqual({
      busy: kind === "loading" ? "true" : "false", role: "log",
      outer: [{ tag: "DIV", class: `agent-empty agent-empty-${kind}`, text: "TitleDescription",
        role: kind === "error" ? "alert" : "status" }],
      details: [],
    });
    act(unmountReact);
  }
});

test("ordered mixed blocks keep source order inside the card and the reply outside it", () => {
  const mixed: AgentTraceItem[] = [user, thinking, { type: "assistant", text: "Intermediate" },
    { type: "tool", name: "Read", output: "done" }, { type: "assistant", text: "Final one" },
    { type: "assistant", text: "Final two" }];
  const outer = () => [...current().querySelector(".agent-stream-inner")!.children].map(node => node.className);
  const steps = () => [...current().querySelectorAll(".work-step")].map(node => node.className);
  act(() => renderReact(<AgentStream items={mixed} working={false} empty={empty} truncated />));
  expect(outer()).toEqual(["agent-trace-limit", "agent-user", "work-card is-neutral", "agent-assistant agent-assistant-final"]);
  // Thinking, the interim note and the tool stay in source order inside the card.
  expect(steps()).toEqual(["work-step is-think", "work-step work-note", "work-step is-read is-ended"]);
  const done = current().querySelector<HTMLDetailsElement>("details.work-card")!;
  expect(done.dataset.key).toBe("w:u:12:Inspect this:s:thinking:::Read:");
  expect(done.open).toBeFalse();
  expect(current().querySelector(".agent-assistant-final")?.textContent).toBe("Final one\nFinal two\n");
  act(unmountReact);
  act(() => renderReact(<AgentStream items={mixed} working empty={empty} truncated />));
  // While the turn runs the card is open and the trailing text is the latest note under it.
  expect(outer()).toEqual(["agent-trace-limit", "agent-user", "work-card is-running", "agent-assistant agent-assistant-intermediate"]);
  const live = current().querySelector<HTMLDetailsElement>("details.work-card")!;
  expect([live.open, live.dataset.autoOpen]).toEqual([true, "1"]);
  expect(current().querySelector(".agent-reply-copy")).toBeNull();
});

test("a retained final reply copies its updated raw text after sanitized Markdown replacement", () => {
  const copied: string[] = [];
  const copy = (text: string) => { copied.push(text); };
  const render = (text: string) => act(() => renderReact(<AgentStream
    items={[user, { type: "assistant", text }]} working={false} empty={empty} onCopyReply={copy} />));
  render("[old](https://example.com)");
  const button = appRoot().querySelector<HTMLButtonElement>(".agent-reply-copy")!;
  const next = "**Latest** <iframe src='https://example.com'></iframe> [bad](javascript:alert(1))";
  render(next);
  expectSameNode(appRoot().querySelector(".agent-reply-copy"), button);
  act(() => button.click());
  expect(copied).toEqual([next]);
  expect(appRoot().querySelector("iframe")).toBeNull();
  expect(appRoot().querySelector('.agent-md a[href^="javascript:"]')).toBeNull();
  expect(appRoot().querySelector('.agent-md a[href="https://example.com"]')).toBeNull();
  expect(appRoot().querySelector(".agent-md strong")?.textContent).toBe("Latest");
});
