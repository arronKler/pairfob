import { closeTestDialogs } from "./close-dialogs";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";

const { resetBoardTestDOM, happy } = await import("./dom");
await resetBoardTestDOM();
happy.happyDOM.setWindowSize({ width: 320, height: 700 });
for (const key of ["innerWidth", "innerHeight"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, get: () => happy[key] });
}
Object.assign(globalThis, { Event: happy.Event, InputEvent: happy.InputEvent });
if (!(document as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
}
const { installEnvironment } = await import("../qa/environment");
installEnvironment();
globalThis.fetch = window.fetch as typeof globalThis.fetch;

const { createFixtureAPI } = await import("../qa/fixtures");
type FixtureAPI = Awaited<ReturnType<typeof createFixtureAPI>>;
let api: FixtureAPI | undefined;

async function start(scene: string): Promise<FixtureAPI> {
  await act(async () => { api = await createFixtureAPI("en", scene); await api.ready; });
  return api!;
}

async function select(scene: string): Promise<void> {
  await act(async () => { await api!.setScene(scene); });
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error("phase2 QA observable did not settle");
}

afterEach(async () => {
  if (!api) return;
  await act(async () => { window.dispatchEvent(new Event("beforeunload")); await Promise.resolve(); });
  api = undefined;
});

test("phase2 long Pi scene includes successful, failed, and empty tool results", async () => {
  await start("chat-pi-long");
  const stream = document.querySelector(".agent-stream")?.textContent ?? "";
  expect(stream).toContain("Turn 1");
  expect(stream).toContain("Turn 12 complete");
  expect(stream).toContain("bun test chat");
  expect(stream).toContain("empty.txt");
  // The failed command is visible on its card without opening anything.
  const steps = [...document.querySelectorAll<HTMLButtonElement>(".work-step")];
  const failed = steps.find((step) => step.textContent?.includes("bun test chat"))!;
  expect(failed.className).toContain("is-error");
  expect(failed.closest("details.work-card")?.className).toBe("work-card is-error");
  // Tool bodies load only when a step's sheet opens, and never enter the stream.
  await act(async () => { failed.click(); await Promise.resolve(); });
  await settle(() => (document.querySelector("dialog.step-sheet")?.textContent ?? "").includes("expected one refresh"));
  expect(api!.calls.some((call) => call.method === "agentTraceDetail" && call.args[1] === "qa-tool-error")).toBeTrue();
  expect(document.querySelector(".agent-stream")?.textContent).not.toContain("expected one refresh");
  closeTestDialogs();
  const empty = steps.find((step) => step.textContent?.includes("empty.txt"))!;
  await act(async () => { empty.click(); await Promise.resolve(); });
  await settle(() => api!.calls.some((call) => call.method === "agentTraceDetail" && call.args[1] === "qa-empty-output"));
  expect(document.querySelector("dialog.step-sheet")?.textContent).not.toContain("export function App");
  closeTestDialogs();
});

test("phase2 unread and recovery scenes expose real fixture actions without mutation replay", async () => {
  const a = await start("chat-pi-unread");
  expect(document.querySelector(".agent-jump")?.hasAttribute("hidden")).toBeFalse();
  await select("chat-pi-recovery");
  a.clearCalls();
  a.setConnected(false);
  a.emit({ type: "reconnecting", message: "QA reconnect" });
  a.appendChatTurn();
  a.setConnected(true);
  a.emit({ type: "connected" });
  a.emit({ type: "poke", reason: "agent_update" });
  await act(async () => { await a.refreshChat(); });
  expect(a.calls.filter((call) => call.method === "agentTrace")).toHaveLength(1);
  expect(a.calls.filter((call) => call.kind === "mutation")).toEqual([]);
  expect(document.querySelector(".agent-stream")?.textContent).toContain("QA appended response 1");
  expect(a.snapshot().scene).toBe("chat-pi-recovery");
  expect(a.snapshot().errors).toEqual([]);
});

test("phase2 narrow compose preserves focused multiline IME selection", async () => {
  const a = await start("chat-pi-compose");
  const input = document.querySelector<HTMLTextAreaElement>(".agent-dock textarea")!;
  expect(input).not.toBeNull();
  expect(innerWidth).toBe(320);
  expect(input.value.split("\n")).toHaveLength(3);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([22, 25]);
  const nodeId = a.snapshot().inputs.find((entry) => entry.focused)?.nodeId;
  const initialTurns = (document.querySelector(".agent-stream")?.textContent?.match(/Turn \d+ complete/g) ?? []).length;
  expect(initialTurns).toBe(12);
  a.appendChatTurn();
  await act(async () => { await a.refreshChat(); });
  expect(document.querySelector(".agent-stream")?.textContent).toContain("QA appended response 1");
  expect(a.calls.filter((call) => call.method === "agentTrace")).toHaveLength(1);
  expect(a.snapshot().inputs.find((entry) => entry.focused)?.nodeId).toBe(nodeId);
  expect(input.value.split("\n")).toHaveLength(3);
  expect(a.snapshot().overflow.documentX).toBe(0);
});
