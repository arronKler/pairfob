import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { setLang, t } from "../../../lib/i18n";
import type { AgentTraceDetail, AgentTraceItem } from "../../../lib/operations";
import type { LiveSession } from "../../../lib/protocol/client";
import { agentTraceDetailState, clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { attachLiveSession } from "../../computers/catalog-store";
import { selectPane, setAgentChat } from "../session-store";
import { openStepSheet } from "./step-sheet";
import { applyTrace } from "./trace-store";

const PANE = "sheet-pane";
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.step-sheet");
const drain = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(async () => {
  await resetTestDOM();
  clearAgentTraceCache();
  setLang("zh");
  setAgentChat(true);
  selectPane(PANE);
});
afterEach(() => {
  closeTestDialogs();
  clearAgentTraceCache();
  attachLiveSession(null);
  setAgentChat(false);
  selectPane("");
});

async function open(item: AgentTraceItem, verified = true): Promise<void> {
  act(() => openStepSheet(PANE, item, verified));
  await drain();
}

test("a step's body loads once on open, renders as text, and is not fetched again on reopen", async () => {
  const requests: string[] = [];
  let resolve!: (value: AgentTraceDetail) => void;
  attachLiveSession({ agentTraceDetail: (_pane: string, ref: string) => {
    requests.push(ref);
    return new Promise<AgentTraceDetail>(finish => { resolve = finish; });
  } } as unknown as LiveSession);
  const item: AgentTraceItem = { type: "tool", name: "Read", label: "src/app/boot.ts", toolState: "done", detailRef: "d1" };
  await open(item);
  expect(requests).toEqual(["d1"]);
  expect(sheet()?.querySelector('[role="status"]')?.textContent).toContain(t("chat.detailLoading"));
  expect(sheet()?.querySelector(".step-pill")?.textContent).toBe(t("work.state.done"));
  await act(async () => {
    resolve({ detailRef: "d1", input: '{"file_path":"src/app/boot.ts","limit":120}', output: "<img src=x onerror=alert(1)>", truncated: true });
    await Promise.resolve();
  });
  // Flat arguments read as a key/value table; output is text, never markup.
  expect([...sheet()!.querySelectorAll(".step-args dt")].map(node => node.textContent)).toEqual(["file_path", "limit"]);
  expect(sheet()!.querySelector(".step-code")?.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(sheet()!.querySelector("img")).toBeNull();
  expect(sheet()!.querySelector(".step-note")?.textContent).toBe(t("sheet.truncated"));
  closeTestDialogs();
  await open(item);
  expect(requests).toEqual(["d1"]);
});

test("a failed read waits for an explicit retry and makes exactly one more request", async () => {
  let calls = 0;
  attachLiveSession({ agentTraceDetail: async (_pane: string, ref: string) => {
    calls += 1;
    if (calls === 1) throw new Error("Unavailable");
    return { detailRef: ref, input: '{"command":"bun test"}', output: "1 fail", truncated: false };
  } } as unknown as LiveSession);
  await open({ type: "tool", name: "Bash", label: "bun test", toolState: "error", detailRef: "d2" });
  expect(calls).toBe(1);
  expect(sheet()!.querySelector('[role="alert"]')).not.toBeNull();
  await drain();
  expect(calls).toBe(1);
  await act(async () => { sheet()!.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); await Promise.resolve(); });
  await drain();
  expect(calls).toBe(2);
  // A command shows as its own block rather than a one-key table.
  expect(sheet()!.querySelector(".step-section h4")?.textContent).toBe(t("sheet.command"));
  expect([...sheet()!.querySelectorAll(".step-code")].map(node => node.textContent)).toEqual(["bun test", "1 fail"]);
});

test("a response for another pane fills only its own cache", async () => {
  let resolve!: (value: AgentTraceDetail) => void;
  attachLiveSession({ agentTraceDetail: () => new Promise<AgentTraceDetail>(finish => { resolve = finish; }) } as unknown as LiveSession);
  await open({ type: "tool", name: "Read", detailRef: "old-ref" });
  closeTestDialogs();
  selectPane("other-pane");
  await act(async () => { resolve({ detailRef: "old-ref", output: "Old private output", truncated: false }); await Promise.resolve(); });
  expect(agentTraceDetailState(PANE, "old-ref").status).toBe("ready");
  expect(document.body.textContent).not.toContain("Old private output");
});

test("thinking opens as plain text without a read", async () => {
  let calls = 0;
  attachLiveSession({ agentTraceDetail: async () => { calls += 1; return { detailRef: "x", truncated: false }; } } as unknown as LiveSession);
  await open({ type: "thinking", text: "Check the boot path first." });
  expect(calls).toBe(0);
  expect(sheet()!.querySelector(".step-prose")?.textContent).toBe("Check the boot path first.");
});

test("previous and next walk the card's steps without closing the sheet", async () => {
  attachLiveSession({ agentTraceDetail: async (_pane: string, ref: string) => ({ detailRef: ref, output: `out ${ref}`, truncated: false }) } as unknown as LiveSession);
  const steps: AgentTraceItem[] = [
    { type: "thinking", text: "Plan the change." },
    { type: "tool", name: "Read", label: "a.ts", toolState: "done", detailRef: "r1" },
    { type: "tool", name: "Bash", label: "bun test", toolState: "done", detailRef: "r2" },
  ];
  act(() => openStepSheet(PANE, steps[1], true, steps));
  await drain();
  const head = () => sheet()!.querySelector(".step-head-copy")?.textContent;
  expect(head()).toBe(`${t("work.cat.read")}a.ts`);
  expect(sheet()!.querySelector(".step-nav-pos")?.textContent).toBe(t("sheet.position", { i: 2, n: 3 }));
  await act(async () => { sheet()!.querySelector<HTMLButtonElement>(`[aria-label="${t("sheet.next")}"]`)!.click(); await Promise.resolve(); });
  await drain();
  expect(head()).toBe(`${t("work.cat.command")}bun test`);
  expect(sheet()!.textContent).toContain("out r2");
  expect(sheet()!.querySelector<HTMLButtonElement>(`[aria-label="${t("sheet.next")}"]`)!.disabled).toBeTrue();
  act(() => sheet()!.querySelector<HTMLButtonElement>(`[aria-label="${t("sheet.prev")}"]`)!.click());
  act(() => sheet()!.querySelector<HTMLButtonElement>(`[aria-label="${t("sheet.prev")}"]`)!.click());
  expect(sheet()!.querySelector(".step-prose")?.textContent).toBe("Plan the change.");
});

test("an open sheet follows its turn: a running step finishes in place and new steps extend the count", async () => {
  const requests: string[] = [];
  attachLiveSession({ agentTraceDetail: async (_pane: string, ref: string) => {
    requests.push(ref);
    return { detailRef: ref, output: ref === "r1-done" ? "all green" : "", truncated: false };
  } } as unknown as LiveSession);
  let current: AgentTraceItem[] = [{ type: "tool", name: "Bash", label: "bun test", toolState: "running", detailRef: "r1" }];
  act(() => openStepSheet(PANE, current[0], true, current, () => current));
  await drain();
  expect(sheet()!.querySelector(".step-pill")?.textContent).toBe(t("work.state.running"));
  current = [{ type: "tool", name: "Bash", label: "bun test", toolState: "done", detailRef: "r1-done" },
    { type: "tool", name: "Read", label: "a.ts", toolState: "running", detailRef: "r2" }];
  // Any trace publication repaints the sheet against the latest steps.
  act(() => applyTrace({ agentTraceSig: "next" }));
  await drain();
  expect(sheet()!.querySelector(".step-pill")?.textContent).toBe(t("work.state.done"));
  expect(sheet()!.textContent).toContain("all green");
  expect(requests).toEqual(["r1", "r1-done"]);
  expect(sheet()!.querySelector(".step-nav-pos")?.textContent).toBe(t("sheet.position", { i: 1, n: 2 }));
});
