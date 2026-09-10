import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang, t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import type { AgentTraceDetailState } from "../../../lib/agent-trace-cache";
import { AgentStream } from "./agent-stream";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => act(unmountReact));

const items: AgentTraceItem[] = [
  { type: "user", text: "Inspect this change" },
  { type: "thinking", text: "Reading\n carefully" },
  { type: "tool", name: "read_file", input: "src/app.ts", output: "file output" },
  { type: "assistant", text: "## Result\n\n**Safe** [reference](https://example.com)" },
];
const empty = { kind: "empty" as const, title: "No history" };

function toggle(card: HTMLDetailsElement, open: boolean) {
  act(() => {
    card.open = open;

  });
}

test("completed turns retain their process fold, Markdown and one final reply copy action", () => {
  const copied: string[] = [];
  act(() => renderReact(<AgentStream items={items} working={false} empty={empty} onCopyReply={text => { copied.push(text); }} />));
  expect(appRoot().querySelector(".agent-user-text")?.textContent).toBe(items[0].text);
  expect(appRoot().querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open).toBeFalse();
  expect(appRoot().querySelectorAll(".agent-step")).toHaveLength(2);
  expect(appRoot().querySelector(".agent-md h2")?.textContent).toBe("Result");
  expect(appRoot().querySelector(".agent-md strong")?.textContent).toBe("Safe");
  const link = appRoot().querySelector(".agent-md a")!;
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(appRoot().querySelectorAll(".agent-reply-copy")).toHaveLength(1);
  act(() => appRoot().querySelector<HTMLButtonElement>(".agent-reply-copy")!.click());
  expect(copied).toEqual([items[3].text!]);
});

test("manual collapse of a live process survives new output and preserves its details node", () => {
  const paint = (text: string) => act(() => renderReact(<AgentStream items={[...items.slice(0, 3), { type: "assistant", text }]}
    working empty={empty} />));
  paint("first partial reply");
  const process = appRoot().querySelector<HTMLDetailsElement>(".agent-process")!;
  expect(process.open).toBeTrue();
  toggle(process, false);
  expect(process.dataset.user).toBe("closed");
  paint("second partial reply");
  expect(appRoot().querySelector(".agent-process") === process).toBeTrue();
  expect(process.open).toBeFalse();
  expect(appRoot().querySelector(".agent-run-status")?.textContent).toContain(t("trace.runningSteps", { n: 3 }));
  expect(appRoot().querySelector(".agent-reply-copy")).toBeNull();
});

test("lazy tool details wait for expansion, render loading/error and retry only by user action", async () => {
  const tool: AgentTraceItem = { type: "tool", name: "read_file", detailRef: "detail-1" };
  let detail: AgentTraceDetailState = { status: "idle" };
  const requests: string[] = [];
  const need = (ref: string) => { requests.push(ref); };
  const view = () => detail;
  const paint = () => act(() => renderReact(<AgentStream items={[{ type: "user", text: "run" }, tool]}
    working empty={empty} toolDetail={view} onNeedToolDetail={need} />));
  paint();
  await act(async () => { await Promise.resolve(); });
  expect(requests).toEqual([]);
  const step = appRoot().querySelector<HTMLDetailsElement>(".agent-step")!;
  toggle(step, true);
  detail = { status: "loading" };
  paint();
  expect(requests).toEqual(["detail-1"]);
  expect(step.querySelector('[role="status"]')?.textContent).toContain(t("chat.detailLoading"));
  detail = { status: "error", message: "Unavailable" };
  paint();
  await act(async () => { await Promise.resolve(); });
  expect(requests).toEqual(["detail-1"]);
  expect(step.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
  act(() => step.querySelector<HTMLButtonElement>(".agent-detail-retry")!.click());
  expect(requests).toEqual(["detail-1", "detail-1"]);
  toggle(step, false);
  toggle(step, true);
  expect(requests).toHaveLength(3);
});

test("duplicate prompts remain separate turns and unsafe Markdown cannot introduce active elements", () => {
  const turns: AgentTraceItem[] = [
    { type: "user", text: "again" }, { type: "assistant", text: "first" },
    { type: "user", text: "again" }, { type: "assistant", text: '<script>alert(1)</script>\n\n[x](javascript:alert(1))' },
  ];
  act(() => renderReact(<AgentStream items={turns} working={false} empty={empty} />));
  expect(appRoot().querySelectorAll(".agent-user")).toHaveLength(2);
  expect(appRoot().querySelectorAll(".agent-assistant-final")).toHaveLength(2);
  expect(appRoot().querySelector("script")).toBeNull();
  expect(appRoot().querySelector('.agent-md a[href^="javascript:"]')).toBeNull();
});

test("error retry and scroll requests use the existing near-top and follow thresholds", () => {
  let retries = 0, older = 0;
  const following: boolean[] = [];
  act(() => renderReact(<AgentStream items={[]} working={false} busy empty={{ kind: "error", title: "Read failed" }}
    onRetry={() => { retries++; }} onNeedOlder={() => { older++; }} onFollow={follow => following.push(follow)} />));
  const stream = appRoot().querySelector<HTMLElement>(".agent-stream")!;
  expect(stream.getAttribute("aria-busy")).toBe("true");
  act(() => appRoot().querySelector<HTMLButtonElement>(".agent-empty button")!.click());
  expect(retries).toBe(1);
  Object.defineProperties(stream, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
  stream.scrollTop = 20;
  act(() => stream.dispatchEvent(new happy.Event("scroll") as unknown as Event));
  stream.scrollTop = 390;
  act(() => stream.dispatchEvent(new happy.Event("scroll") as unknown as Event));
  expect(older).toBe(1);
  expect(following).toEqual([false, true]);
});
