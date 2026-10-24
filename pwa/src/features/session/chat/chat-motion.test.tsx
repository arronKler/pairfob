import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang, t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { MOTION_MS } from "../../../shared/ui/dom/motion";
import { AgentStream, type PromptProgressNote } from "./agent-stream";

/**
 * What moves in the transcript, and what must not. The stream is drawn again by
 * every poll, by older history and by React itself; only a change the reader
 * could watch happen may carry one of these marks.
 */
const MARKS = ".rise-in, .pop-in, .swap-in, .is-arriving, .is-raised, .is-following, .has-arrived, .fold-appear, .work-steps-pushed";
const marks = (): string[] => [...appRoot().querySelectorAll(MARKS)].map((node) => node.getAttribute("class") ?? "");

type Slide = { on: string; from: string };
let slides: Slide[] = [];
const prototype = happy.HTMLElement.prototype as unknown as Record<string, unknown>;
const own = { offsetHeight: Object.getOwnPropertyDescriptor(prototype, "offsetHeight"), animate: Object.getOwnPropertyDescriptor(prototype, "animate") };

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
  slides = [];
  // Happy DOM has no layout and no Web Animations: a pushed row is one row tall, and a move is recorded.
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("work-steps-pushed") ? 44 * this.children.length : 0; },
  });
  prototype.animate = function (this: HTMLElement, frames: Array<{ transform: string }>) {
    slides.push({ on: this.className, from: frames[0].transform });
    return {};
  };
});
afterEach(() => {
  act(unmountReact);
  // The realm is every other suite's too: it gets back exactly what it had.
  for (const [name, descriptor] of Object.entries(own)) {
    if (descriptor) Object.defineProperty(prototype, name, descriptor);
    else delete prototype[name];
  }
});

const empty = { kind: "empty" as const, title: "No history" };
const tool = (file: string, state: "running" | "done" = "done"): AgentTraceItem =>
  ({ type: "tool", name: "Read", label: file, input: `{"path":"${file}"}`, toolState: state });
/**
 * A step of its own kind, so a list of them never folds into one row: these
 * cases are about the window moving, and a folded run would hide the rows the
 * window is supposed to carry.
 */
const kinds = ["Read", "Bash", "Grep", "Edit", "WebFetch", "Agent", "TodoWrite", "AskUserQuestion", "Read"];
const toolOf = (file: string, state: "running" | "done" = "done", kind = 0): AgentTraceItem =>
  ({ type: "tool", name: kinds[kind]!, label: file, input: `{"path":"${file}"}`, toolState: state });
const done: AgentTraceItem[] = [
  { type: "user", text: "First question" }, tool("old.ts"), { type: "assistant", text: "First answer" },
];
/** A poll hands back the same transcript as new objects. */
const polled = (items: AgentTraceItem[]): AgentTraceItem[] => items.map((item) => ({ ...item }));

type Paint = {
  working?: boolean; waiting?: boolean; follow?: boolean; hasOlder?: boolean; historyLoads?: number; progress?: PromptProgressNote | null;
  /** The transcript is being read: the stream shows that instead of "no history". */
  reading?: boolean;
};
function paint(items: AgentTraceItem[], state: Paint = {}): void {
  act(() => renderReact(<AgentStream items={polled(items)} empty={state.reading ? { kind: "loading", title: "Reading" } : empty} busy={state.reading} verified working={state.working ?? false}
    waiting={state.waiting} follow={state.follow} hasOlder={state.hasOlder} historyLoads={state.historyLoads}
    progress={state.progress} onCopyReply={() => true} onTerminal={() => {}} />));
}
const rows = (): string[] => [...appRoot().querySelectorAll(".work-steps:not(.work-steps-pushed) .work-step-text")].map((node) => node.textContent ?? "");

test("a transcript that is already there is drawn still, whatever state its last turn is in", () => {
  const live = [...done, { type: "user" as const, text: "Second question" }, tool("a.ts"), tool("b.ts"), tool("c.ts"), tool("d.ts"), tool("e.ts", "running")];
  paint(live, { working: true });
  expect(marks()).toEqual([]);
  act(unmountReact);
  // An agent that was already waiting when the reader opened the conversation.
  paint(live, { working: true, waiting: true });
  expect(appRoot().querySelector(".needs-card")?.className).toBe("needs-card");
  expect(marks()).toEqual([]);
  act(unmountReact);
  // A prompt that was already on its way.
  paint([...done, { type: "user", text: "Still sending", pending: true }], { progress: { message: "正在发送…", attention: false, settled: false } });
  expect([appRoot().querySelectorAll(".agent-user")[1].className, appRoot().querySelector(".pending-card")?.className])
    .toEqual(["agent-user", "pending-card"]);
  expect(marks()).toEqual([]);
  expect(slides).toEqual([]);
});

test("a poll that brings nothing new moves nothing and keeps every node", () => {
  const live = [...done, { type: "user" as const, text: "Second question" }, tool("a.ts"), tool("b.ts"), tool("c.ts"), tool("d.ts"), tool("e.ts", "running")];
  paint(live, { working: true });
  const before = [...appRoot().querySelectorAll(".agent-user, .work-card, .work-steps li, .agent-assistant")];
  paint(live, { working: true });
  paint(live, { working: true });
  const after = [...appRoot().querySelectorAll(".agent-user, .work-card, .work-steps li, .agent-assistant")];
  expect(after).toHaveLength(before.length);
  after.forEach((node, index) => expectSameNode(node, before[index]));
  expect(marks()).toEqual([]);
  expect(slides).toEqual([]);
});

test("older history loading in front of the transcript moves nothing", () => {
  const live = [{ type: "user" as const, text: "Second question" }, tool("a.ts"), tool("b.ts"), tool("c.ts"), tool("d.ts"), tool("e.ts", "running")];
  paint(live, { working: true, hasOlder: true });
  // Whole turns in front: every index shifts.
  paint([...done, ...live], { working: true, historyLoads: 1 });
  expect(marks()).toEqual([]);
  // The same without the stream being told: the steps themselves say nothing was added at the end.
  paint([{ type: "user", text: "Even older" }, { type: "assistant", text: "Answer" }, ...done, ...live], { working: true, historyLoads: 1 });
  expect(marks()).toEqual([]);
  expect(slides).toEqual([]);
});

test("older history reaching into the running turn does not make its newest steps new", () => {
  // The page starts mid-turn: the turn's own earlier steps are what the older page holds.
  const tail = [tool("e.ts"), tool("f.ts"), tool("g.ts"), tool("h.ts"), tool("i.ts", "running")];
  paint(tail, { working: true, hasOlder: true });
  expect(rows()).toEqual(["f.ts", "g.ts", "h.ts", "i.ts"]);
  const earlier = [tool("a.ts"), tool("b.ts"), tool("c.ts"), tool("d.ts")];
  paint([...earlier, ...tail], { working: true, hasOlder: true, historyLoads: 1 });
  expect(rows()).toEqual(["f.ts", "g.ts", "h.ts", "i.ts"]);
  expect(marks()).toEqual([]);
  // And once more with the turn's prompt on the page in front.
  paint([{ type: "user", text: "Long task" }, ...earlier, ...tail], { working: true, historyLoads: 2 });
  expect(marks()).toEqual([]);
  expect(slides).toEqual([]);
});

test("a prompt the reader sends rises in with its delivery card behind it, and keeps its node until its turn is over", () => {
  const sending = { message: "正在发送…", attention: false, settled: false };
  paint(done);
  paint([...done, { type: "user", text: "Check the layout", pending: true }], { progress: sending });
  const bubble = appRoot().querySelectorAll(".agent-user")[1];
  expect(bubble.className).toBe("agent-user rise-in");
  expect(appRoot().querySelector(".pending-card")?.className).toBe("pending-card rise-in is-following");
  // The bubble before it did not arrive.
  expect(appRoot().querySelectorAll(".agent-user")[0].className).toBe("agent-user");
  expect(appRoot().querySelector(".pending-card .swap-in")).toBeNull();
  // Delivery advances: the words swap, the card and the bubble stay the nodes they were.
  const card = appRoot().querySelector(".pending-card");
  paint([...done, { type: "user", text: "Check the layout", pending: true }],
    { progress: { message: "已提交，等待观察到处理开始", attention: false, settled: false } });
  expectSameNode(appRoot().querySelector(".pending-card"), card);
  expectSameNode(appRoot().querySelectorAll(".agent-user")[1], bubble);
  expect(card?.querySelector(".swap-in")?.textContent).toBe("已提交，等待观察到处理开始");
  // The transcript records it, then the turn's first step arrives: its key changes shape, the bubble does not remount.
  paint([...done, { type: "user", text: "Check the layout" }], { working: true });
  expectSameNode(appRoot().querySelectorAll(".agent-user")[1], bubble);
  paint([...done, { type: "user", text: "Check the layout" }, { type: "thinking", text: "Looking" }], { working: true });
  expectSameNode(appRoot().querySelectorAll(".agent-user")[1], bubble);
  paint([...done, { type: "user", text: "Check the layout" }, { type: "thinking", text: "Looking" }, tool("a.ts", "running")], { working: true });
  expectSameNode(appRoot().querySelectorAll(".agent-user")[1], bubble);
  // Recorded, it is a prompt like any other; what arrived now is the step.
  expect(bubble.className).toBe("agent-user");
  expect(marks()).toEqual(["is-arriving"]);
  expect(appRoot().querySelector(".work-steps .is-arriving")?.textContent).toBe("a.ts");
  expect(appRoot().querySelectorAll(".work-card")).toHaveLength(2);
});

test("history loading while a prompt is on its way takes the arrival off it", () => {
  const pending: AgentTraceItem = { type: "user", text: "Check the layout", pending: true };
  const sending = { message: "正在发送…", attention: false, settled: false };
  paint(done, { hasOlder: true });
  paint([...done, pending], { progress: sending, hasOlder: true });
  expect(marks()).toEqual(["agent-user rise-in", "pending-card rise-in is-following"]);
  paint([{ type: "user", text: "Older" }, { type: "assistant", text: "Answer" }, ...done, pending], { progress: sending, historyLoads: 1 });
  expect(marks()).toEqual([]);
});

test("a step that arrives pushes a full list up by the row it displaces and fades in; the step before it gets its mark", async () => {
  const turn = (...steps: AgentTraceItem[]): AgentTraceItem[] => [{ type: "user", text: "Go" }, ...steps];
  paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "running", 2)), { working: true });
  // The list is not full yet: the newcomer joins at the end, nothing is displaced.
  paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "done", 2), toolOf("d.ts", "running", 3)), { working: true });
  expect(rows()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  expect([...appRoot().querySelectorAll(".work-steps li")].map((row) => row.className)).toEqual(["", "", "", "is-arriving"]);
  // The step that was running in front of the reader has its result: the mark pops, on that row only.
  expect([...appRoot().querySelectorAll(".work-step-state")].map((mark) => mark.classList.contains("pop-in")))
    .toEqual([false, false, true, false]);
  expect(appRoot().querySelector(".work-steps-pushed")).toBeNull();
  expect(slides).toEqual([]);
  // The fifth step: the first row leaves the window, kept on the track for the length of the move.
  const kept = [...appRoot().querySelectorAll(".work-steps li")].slice(1);
  paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "done", 2), toolOf("d.ts", "done", 3), toolOf("e.ts", "running", 4)), { working: true });
  expect(rows()).toEqual(["b.ts", "c.ts", "d.ts", "e.ts"]);
  const pushed = appRoot().querySelector(".work-steps-pushed")!;
  expect([pushed.textContent, pushed.hasAttribute("inert"), pushed.getAttribute("aria-hidden")]).toEqual(["a.ts", true, "true"]);
  expect(slides).toEqual([{ on: "work-steps-track", from: "translateY(44px)" }]);
  const live = [...appRoot().querySelectorAll(".work-steps:not(.work-steps-pushed) li")];
  // The rows that stay are the nodes they were; only the last one is new.
  live.slice(0, 3).forEach((row, index) => expectSameNode(row, kept[index]));
  expect(live.map((row) => row.className)).toEqual(["", "", "", "is-arriving"]);
  // The second ticks of the elapsed time and the next poll repaint the card: nothing plays again.
  paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "done", 2), toolOf("d.ts", "done", 3), toolOf("e.ts", "running", 4)), { working: true });
  expect(slides).toHaveLength(1);
  [...appRoot().querySelectorAll(".work-steps:not(.work-steps-pushed) li")].forEach((row, index) => expectSameNode(row, live[index]));
  // The move over, the row that left is gone.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, MOTION_MS.panel + 40)); });
  expect(appRoot().querySelector(".work-steps-pushed")).toBeNull();
  expect(rows()).toEqual(["b.ts", "c.ts", "d.ts", "e.ts"]);
});

test("under reduced motion a new step only fades in: no row is kept and the list does not travel", () => {
  const globals = globalThis as unknown as { matchMedia: unknown };
  const media = globals.matchMedia;
  globals.matchMedia = () => ({ matches: true });
  try {
    const turn = (...steps: AgentTraceItem[]): AgentTraceItem[] => [{ type: "user", text: "Go" }, ...steps];
    paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "done", 2), toolOf("d.ts", "running", 3)), { working: true });
    paint(turn(toolOf("a.ts", "done", 0), toolOf("b.ts", "done", 1), toolOf("c.ts", "done", 2), toolOf("d.ts", "done", 3), toolOf("e.ts", "running", 4)), { working: true });
    expect(rows()).toEqual(["b.ts", "c.ts", "d.ts", "e.ts"]);
    expect(appRoot().querySelector(".work-steps-pushed")).toBeNull();
    expect(slides).toEqual([]);
    expect(appRoot().querySelector(".work-steps .is-arriving")?.textContent).toBe("e.ts");
  } finally {
    globals.matchMedia = media;
  }
});

test("the reader's own filter and \"earlier steps\" redraw the list without an arrival", () => {
  // Each step a kind of its own: this case counts rows, and a folded run would
  // stand for several of them.
  const many = [{ type: "user" as const, text: "Go" }, ...Array.from({ length: 9 }, (_, index) => toolOf(`f${index}.ts`, "done", index))];
  paint(many, { working: true });
  act(() => appRoot().querySelector<HTMLButtonElement>(".work-earlier")!.click());
  expect(rows()).toHaveLength(9);
  expect(marks()).toEqual([]);
  expect(slides).toEqual([]);
});

test("the turn ends: the card folds shut with its steps still in it, its mark pops, its words swap and the reply's actions follow", () => {
  const steps = [{ type: "user" as const, text: "Go" }, tool("a.ts"), tool("b.ts", "running")];
  paint([...steps, { type: "assistant", text: "Working on it" }], { working: true });
  const card = appRoot().querySelector(".work-card")!;
  const head = card.querySelector<HTMLButtonElement>("button.work-head")!;
  const fold = card.querySelector<HTMLElement>(".fold")!;
  const reply = appRoot().querySelector(".agent-md")!;
  // The head is the control: it names the body it opens and says that it is open.
  expect([head.getAttribute("aria-expanded"), head.getAttribute("aria-controls") === fold.id, fold.hasAttribute("inert")]).toEqual(["true", true, false]);
  expect(marks()).toEqual([]);
  paint([{ type: "user", text: "Go" }, tool("a.ts"), tool("b.ts"), { type: "assistant", text: "All done" }]);
  expectSameNode(appRoot().querySelector(".work-card"), card);
  expectSameNode(card.querySelector(".fold"), fold);
  expect([head.getAttribute("aria-expanded"), fold.classList.contains("is-shut"), fold.hasAttribute("inert")]).toEqual(["false", true, true]);
  // Folded, not removed: there is something to see leaving, and nothing appears on mount.
  expect(fold.querySelectorAll(".work-step")).toHaveLength(2);
  expect(fold.classList.contains("fold-appear")).toBeFalse();
  expect(card.querySelector(".work-tone")?.getAttribute("class")).toContain("pop-in");
  expect(card.querySelector(".work-title")?.className).toBe("work-title swap-in");
  expect(card.querySelector(".work-title")?.textContent).toBe(t("work.doneSteps", { n: 2 }));
  // The reply is the node the note was: its colour can ease instead of being swapped.
  expectSameNode(appRoot().querySelector(".agent-md"), reply);
  expect(reply.parentElement?.className).toBe("agent-assistant agent-assistant-final");
  expect(appRoot().querySelector(".agent-reply-actions")?.className).toBe("agent-reply-actions is-arriving");
  // A press opens it again by the same fold, and Enter or Space press a button.
  act(() => head.click());
  expect([head.tagName, head.getAttribute("aria-expanded"), fold.classList.contains("is-shut"), fold.hasAttribute("inert")])
    .toEqual(["BUTTON", "true", false, false]);
  act(unmountReact);
  // The same finished turn drawn from scratch has none of it.
  paint([{ type: "user", text: "Go" }, tool("a.ts"), tool("b.ts"), { type: "assistant", text: "All done" }]);
  expect(marks()).toEqual([]);
  expect(appRoot().querySelector(".agent-reply-actions")?.className).toBe("agent-reply-actions");
});

test("a card with no step to show has a plain line for a head, not a control", () => {
  paint([{ type: "user", text: "Go" }], { working: true });
  const head = appRoot().querySelector(".work-card .work-head")!;
  expect([head.tagName, head.hasAttribute("aria-expanded"), appRoot().querySelector(".work-card .fold")]).toEqual(["DIV", false, null]);
});

test("an agent that stops to ask in front of the reader raises its card; the step count ticking over swaps nothing", () => {
  const steps = [{ type: "user" as const, text: "Clean up" }, tool("a.ts")];
  paint(steps, { working: true });
  const title = appRoot().querySelector(".work-title")!;
  // One more step is the same state with another number: the words are replaced in place.
  paint([...steps, tool("b.ts", "running")], { working: true });
  expectSameNode(appRoot().querySelector(".work-title"), title);
  expect(title.className).toBe("work-title");
  paint([...steps, tool("b.ts", "running")], { working: true, waiting: true });
  expect(appRoot().querySelector(".needs-card")?.className).toBe("needs-card rise-in is-raised");
  expect(appRoot().querySelector(".work-title")?.className).toBe("work-title swap-in");
  // Drawn again while it waits, it is the same card and does not rise twice.
  const needs = appRoot().querySelector(".needs-card");
  paint([...steps, tool("b.ts", "running")], { working: true, waiting: true });
  expectSameNode(appRoot().querySelector(".needs-card"), needs);
});

test("the transcript that takes the place of reading fades in once; a poll of it, and one that was there from the start, do not", () => {
  const inner = () => appRoot().querySelector(".agent-stream-inner")!;
  paint([], { reading: true });
  expect(inner().className).toBe("agent-stream-inner");
  paint(done);
  const arrived = inner();
  expect(arrived.className).toBe("agent-stream-inner has-arrived");
  // A poll draws the same node with the same class: nothing for an animation to start on.
  paint(done);
  expectSameNode(inner(), arrived);
  expect(arrived.className).toBe("agent-stream-inner has-arrived");
  // Read again (a retry after an error): the mark goes while it reads, and the next transcript arrives anew.
  paint([], { reading: true });
  expect(inner().className).toBe("agent-stream-inner");
  paint(done);
  expect(inner().className).toBe("agent-stream-inner has-arrived");
  // A conversation that was read before it was opened is just there.
  act(unmountReact);
  paint(done);
  expect(inner().className).toBe("agent-stream-inner");
});

test("a long prompt opens and shuts by height: shutting, its lines stay drawn until the bubble has closed over them", () => {
  // No layout here: every prompt is 400px of text, 168px once clamped, and a move is one the test ends itself.
  const moves: Array<{ from: string; to: string; end: () => void }> = [];
  const scrollHeight = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  const rect = prototype.getBoundingClientRect;
  Object.defineProperty(prototype, "scrollHeight", { configurable: true, get() { return 400; } });
  prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { height: this.classList.contains("is-clamped") ? 168 : 400, top: 0, left: 0, right: 0, bottom: 0, width: 0, x: 0, y: 0 };
  };
  prototype.animate = function (this: HTMLElement, frames: Array<{ height: string }>) {
    const listeners: Array<() => void> = [];
    moves.push({ from: frames[0].height, to: frames[1].height, end: () => listeners.forEach((listener) => listener()) });
    return { addEventListener: (type: string, listener: () => void) => { if (type === "finish") listeners.push(listener); } };
  };
  try {
    paint([{ type: "user", text: Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n") }, { type: "assistant", text: "ok" }]);
    const text = appRoot().querySelector<HTMLElement>(".agent-user-text")!;
    const more = () => appRoot().querySelector<HTMLButtonElement>(".agent-user-more")!;
    expect(text.className).toBe("agent-user-text is-clamped");
    // Opened: from the height the clamp gave it to the height of all its lines.
    act(() => more().click());
    expect(text.className).toBe("agent-user-text");
    expect(moves.map(({ from, to }) => [from, to])).toEqual([["168px", "400px"]]);
    // Shut: the bubble closes to eight lines over text that is still all there.
    act(() => more().click());
    expect(more().getAttribute("aria-expanded")).toBe("false");
    expect(text.className).toBe("agent-user-text");
    expect(moves.map(({ from, to }) => [from, to])[1]).toEqual(["400px", "168px"]);
    act(() => moves[1].end());
    expect(text.className).toBe("agent-user-text is-clamped");
  } finally {
    if (scrollHeight) Object.defineProperty(prototype, "scrollHeight", scrollHeight); else delete prototype.scrollHeight;
    prototype.getBoundingClientRect = rect;
  }
});
