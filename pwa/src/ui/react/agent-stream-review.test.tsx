import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { app, state } from "../../state";
import { setLang } from "../../lib/i18n";
import type { AgentTraceDetail, AgentTraceItem } from "../../lib/operations";
import { agentTraceDetailState, clearAgentTraceCache } from "../../lib/agent-trace-cache";
import { loadToolDetail, toolDetailView } from "../agent-chat-detail";
import { readDetailsState, type AgentEmptySpec } from "../agent-chat-stream";
import { AgentDetails } from "./agent-details";
import { AgentStream } from "./agent-stream";
import { leaveReactScreen, renderReactScreen } from "./root";

const empty: AgentEmptySpec = { kind: "empty", title: "No history" };
const user: AgentTraceItem = { type: "user", text: "Inspect this" };
const thinking: AgentTraceItem = { type: "thinking", text: "Start by checking" };

beforeEach(async () => {
  await resetTestDOM();
  clearAgentTraceCache();
  setLang("zh");
  state.agentChat = true;
  state.paneId = "review-pane";
});
afterEach(() => {
  act(leaveReactScreen);
  clearAgentTraceCache();
  state.live = null;
  state.agentChat = false;
  state.paneId = "";
});

function toggle(card: HTMLDetailsElement, open: boolean): void {
  act(() => {
    card.open = open;
  });
}
function current(): HTMLElement { return app.querySelector<HTMLElement>(".agent-stream")!; }
function tool(name: string): HTMLDetailsElement {
  const found = [...app.querySelectorAll<HTMLDetailsElement>("details.agent-tool")]
    .find(card => card.querySelector(".agent-step-title")?.textContent === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}
function paint(items: AgentTraceItem[], working = true): void {
  const kept = readDetailsState(app.querySelector(".agent-stream"));
  act(() => renderReactScreen(<AgentStream items={items} working={working} empty={empty} kept={kept} />));
}
async function drain(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

test("a replaced tool identity does not inherit the preceding tool's manual expansion", () => {
  const original: AgentTraceItem[] = [user, thinking, { type: "tool", name: "Read", input: "first.txt" }];
  const replacement: AgentTraceItem[] = [user, thinking, { type: "tool", name: "Read", input: "second.txt" }];
  paint(original);
  const previous = app.querySelector<HTMLDetailsElement>(".agent-tool")!;
  toggle(previous, true);
  const oldKey = previous.dataset.key;
  paint(replacement);
  const next = app.querySelector<HTMLDetailsElement>(".agent-tool")!;
  expect(next.dataset.key === oldKey).toBeFalse();
  expect(next.open).toBeFalse();
  expect(next.dataset.user).toBeUndefined();
});

test("prepending a repeated prompt preserves only the matching tool choice", () => {
  const turn = (name: string): AgentTraceItem[] => [
    { type: "user", text: "Again" }, { type: "thinking", text: `Check ${name}` },
    { type: "tool", name, output: "done" }, { type: "assistant", text: `Result ${name}` },
  ];
  const initial = [...turn("Tool A"), ...turn("Tool B")];
  paint(initial, false);
  toggle(tool("Tool B"), true);
  const prepended = [...turn("Tool Older"), ...initial];
  paint(prepended, false);
  expect([tool("Tool Older").open, tool("Tool A").open, tool("Tool B").open])
    .toEqual([false, false, true]);
});

test("prepending a distinct turn restores open nested details through captured stable keys", () => {
  const initial: AgentTraceItem[] = [user, thinking, { type: "tool", name: "Read", output: "done" },
    { type: "assistant", text: "Finished" }];
  paint(initial, false);
  const fold = app.querySelector<HTMLDetailsElement>(".agent-reply-fold")!;
  toggle(fold, true);
  toggle(tool("Read"), true);
  paint([{ type: "user", text: "Older" }, { type: "assistant", text: "Old answer" }, ...initial], false);
  expect(app.querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open).toBeTrue();
  expect(tool("Read").open).toBeTrue();
});

test("a queued lazy-open notification is cancelled when its details unmount before the microtask", async () => {
  const requests: string[] = [];
  act(() => {
    renderReactScreen(<AgentDetails traceKey="pending" className="agent-step" auto
      onOpen={source => requests.push(source)}><summary>Pending</summary></AgentDetails>);
    leaveReactScreen();
  });
  await drain();
  expect(requests).toEqual([]);
});

test("real lazy detail cache sends once and keeps a closed card closed when the response arrives", async () => {
  const requests: string[] = [];
  let resolve!: (value: AgentTraceDetail) => void;
  state.live = { agentTraceDetail: (_pane: string, ref: string) => {
    requests.push(ref);
    return new Promise<AgentTraceDetail>(finish => { resolve = finish; });
  } } as unknown as NonNullable<typeof state.live>;
  const items: AgentTraceItem[] = [user, thinking, { type: "tool", name: "Read", detailRef: "detail-one" }];
  const need = (ref: string) => loadToolDetail("review-pane", ref, render);
  const view = (item: AgentTraceItem) => toolDetailView("review-pane", item.detailRef || "");
  function render(): void {
    const kept = readDetailsState(app.querySelector(".agent-stream"));
    renderReactScreen(<AgentStream items={items} working empty={empty} kept={kept}
      toolDetail={view} onNeedToolDetail={need} />);
  }
  act(render);
  const card = tool("Read");
  toggle(card, true);
  await drain();
  expect(requests).toEqual(["detail-one"]);
  expect(card.querySelector('[role="status"]')).not.toBeNull();
  toggle(card, false);
  await act(async () => {
    resolve({ detailRef: "detail-one", output: "<img src=x onerror=alert(1)>", truncated: true });
    await Promise.resolve();
  });
  expect(tool("Read") === card).toBeTrue();
  expect(card.open).toBeFalse();
  expect(card.querySelector("pre")?.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(card.querySelector("img")).toBeNull();
  expect(card.querySelector(".agent-detail-limit")).not.toBeNull();
  toggle(card, true);
  await drain();
  expect(requests).toHaveLength(1);
});

test("a real failed lazy request waits for explicit reopening and makes one retry", async () => {
  let calls = 0;
  state.live = { agentTraceDetail: async (_pane: string, ref: string) => {
    calls += 1;
    if (calls === 1) throw new Error("Unavailable");
    return { detailRef: ref, output: "Retry result", truncated: false };
  } } as unknown as NonNullable<typeof state.live>;
  const items: AgentTraceItem[] = [user, { type: "tool", name: "Read", detailRef: "detail-retry" }];
  const need = (ref: string) => loadToolDetail("review-pane", ref, render);
  function render(): void {
    renderReactScreen(<AgentStream items={items} working empty={empty}
      toolDetail={item => toolDetailView("review-pane", item.detailRef || "")}
      onNeedToolDetail={need} />);
  }
  act(render);
  toggle(tool("Read"), true);
  await drain();
  expect(calls).toBe(1);
  expect(tool("Read").querySelector('[role="alert"]')).not.toBeNull();
  act(render);
  await drain();
  expect(calls).toBe(1);
  toggle(tool("Read"), false);
  toggle(tool("Read"), true);
  await drain();
  expect(calls).toBe(2);
  expect(tool("Read").querySelector("pre")?.textContent).toBe("Retry result");
});

test("a tool response after switching panes updates only its owning cache", async () => {
  let resolve!: (value: AgentTraceDetail) => void;
  let repaints = 0;
  state.live = { agentTraceDetail: () => new Promise<AgentTraceDetail>(finish => { resolve = finish; }) } as unknown as NonNullable<typeof state.live>;
  const original: AgentTraceItem[] = [user, { type: "tool", name: "Old tool", detailRef: "old-ref" }];
  const paintOriginal = () => {
    repaints += 1;
    renderReactScreen(<AgentStream items={original} working empty={empty}
      toolDetail={item => toolDetailView("review-pane", item.detailRef || "")}
      onNeedToolDetail={ref => loadToolDetail("review-pane", ref, paintOriginal)} />);
  };
  act(paintOriginal);
  toggle(tool("Old tool"), true);
  await drain();
  const before = repaints;
  state.paneId = "new-pane";
  act(leaveReactScreen);
  paint([{ type: "user", text: "New pane" }, { type: "assistant", text: "Current response" }], false);
  await act(async () => {
    resolve({ detailRef: "old-ref", output: "Old private output", truncated: false });
    await Promise.resolve();
  });
  expect(repaints).toBe(before);
  expect(agentTraceDetailState("review-pane", "old-ref").status).toBe("ready");
  expect(app.textContent).toContain("Current response");
  expect(app.textContent).not.toContain("Old private output");
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
    act(() => renderReactScreen(<AgentStream items={[]} working={false} busy={kind === "loading"}
      empty={{ kind, title: "Title", sub: "Description" }} />));
    expect(streamShape(current())).toEqual({
      busy: kind === "loading" ? "true" : "false", role: "log",
      outer: [{ tag: "DIV", class: `agent-empty agent-empty-${kind}`, text: "TitleDescription",
        role: kind === "error" ? "alert" : "status" }],
      details: [],
    });
    act(leaveReactScreen);
  }
});

test("ordered mixed blocks retain text, truncation, fold keys, and working expansion", () => {
  const mixed: AgentTraceItem[] = [user, thinking, { type: "assistant", text: "Intermediate" },
    { type: "tool", name: "Read", output: "done" }, { type: "assistant", text: "Final one" },
    { type: "assistant", text: "Final two" }];
  const block = (tag: string, className: string, text: string, role: string | null = null) =>
    ({ tag, class: className, text, role });
  const detail = (key: string, className: string, open = false, auto?: string) =>
    ({ key, class: className, open, auto });
  const prefix = [
    block("P", "agent-trace-limit", "部分较长内容已省略"),
    block("ARTICLE", "agent-user", "Inspect this"),
  ];
  // These exact keys preserve saved expansion when earlier turns are prepended.
  const expected = [
    {
      busy: "false", role: "log",
      outer: [...prefix,
        block("DETAILS", "agent-process agent-reply-fold",
          "执行过程 · 3 步思考Start by checkingStart by checkingIntermediate\n✓Read结果done"),
        block("ARTICLE", "agent-assistant agent-assistant-final", "Final one\nFinal two\n")],
      details: [
        detail("f:u:12:Inspect this:s:thinking::", "agent-process agent-reply-fold"),
        detail("u:12:Inspect this:s:thinking:::0:thinking::", "agent-step agent-thinking"),
        detail("u:12:Inspect this:s:thinking:::2:tool:Read:", "agent-step agent-tool is-done")],
    },
    {
      busy: "false", role: "log",
      outer: [...prefix,
        block("DETAILS", "agent-process", "思考过程思考Start by checkingStart by checking"),
        block("ARTICLE", "agent-assistant agent-assistant-intermediate", "Intermediate\n"),
        block("DETAILS", "agent-process", "正在执行✓Read结果done"),
        block("ARTICLE", "agent-assistant agent-assistant-intermediate", "Final one\nFinal two\n"),
        block("DIV", "agent-run-status", "正在执行 · 5 步", "status")],
      details: [
        detail("p:u:12:Inspect this:s:thinking:::0", "agent-process"),
        detail("u:12:Inspect this:s:thinking:::0:0:thinking::", "agent-step agent-thinking"),
        detail("p:u:12:Inspect this:s:thinking:::2", "agent-process", true, "1"),
        detail("u:12:Inspect this:s:thinking:::2:0:tool:Read:", "agent-step agent-tool is-done")],
    },
  ];
  for (const [index, working] of [false, true].entries()) {
    act(() => renderReactScreen(<AgentStream items={mixed} working={working} empty={empty} truncated />));
    expect(streamShape(current())).toEqual(expected[index]);
    act(leaveReactScreen);
  }
});

test("a retained final reply copies its updated raw text after sanitized Markdown replacement", () => {
  const copied: string[] = [];
  const copy = (text: string) => { copied.push(text); };
  const render = (text: string) => act(() => renderReactScreen(<AgentStream
    items={[user, { type: "assistant", text }]} working={false} empty={empty} onCopyReply={copy} />));
  render("[old](https://example.com)");
  const button = app.querySelector<HTMLButtonElement>(".agent-reply-copy")!;
  const next = "**Latest** <iframe src='https://example.com'></iframe> [bad](javascript:alert(1))";
  render(next);
  expect(app.querySelector(".agent-reply-copy") === button).toBeTrue();
  act(() => button.click());
  expect(copied).toEqual([next]);
  expect(app.querySelector("iframe")).toBeNull();
  expect(app.querySelector('.agent-md a[href^="javascript:"]')).toBeNull();
  expect(app.querySelector('.agent-md a[href="https://example.com"]')).toBeNull();
  expect(app.querySelector(".agent-md strong")?.textContent).toBe("Latest");
});
