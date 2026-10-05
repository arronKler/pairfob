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

for (const board of [false, true]) {
  for (const gesture of [false, true]) {
    test(`leaving a completed chat marks only its current turn read (board=${board}, gesture=${gesture})`, async () => {
      await start("chat");
      const { snapshot, PANE } = await import("../qa/data");
      const { replaceAgentsFromSnapshot, dashboardStore, loadCompletionSeen } = await import("../src/features/dashboard/catalog-store");
      const { setBoardReturn } = await import("../src/features/board/layout-store");
      const { goBackFromPane } = await import("../src/features/session/pane-actions");
      const completed = snapshot();
      for (const pane of completed.panes ?? []) {
        if (pane.pane_id === PANE) {
          pane.agent_status = "done";
          pane.state_change_seq = 10;
        }
      }
      await act(async () => {
        setBoardReturn(board);
        replaceAgentsFromSnapshot(completed);
        await api!.render();
      });
      expect(dashboardStore.get().agents.find((pane) => pane.paneId === PANE)?.status).toBe("done");
      const others = dashboardStore.get().agents.filter((pane) => pane.paneId !== PANE);
      await act(async () => {
        if (gesture) await goBackFromPane({ gesture: true });
        else document.querySelector<HTMLButtonElement>(".chrome-back button")!.click();
      });
      await settle(() => api!.snapshot().screen === (board ? "board" : "home"));
      expect(dashboardStore.get().agents.find((pane) => pane.paneId === PANE)?.status).toBe("idle");
      expect(loadCompletionSeen()[PANE]).toBe(dashboardStore.get().completionSeen[PANE]);
      expect(dashboardStore.get().agents.filter((pane) => pane.paneId !== PANE)).toEqual(others);
      // Polling the same completion cannot restore the badge; a later turn can.
      await act(async () => { replaceAgentsFromSnapshot(completed); });
      expect(dashboardStore.get().agents.find((pane) => pane.paneId === PANE)?.status).toBe("idle");
      completed.panes!.find((pane) => pane.pane_id === PANE)!.state_change_seq = 11;
      await act(async () => { replaceAgentsFromSnapshot(completed); });
      expect(dashboardStore.get().agents.find((pane) => pane.paneId === PANE)?.status).toBe("done");
    });
  }
}

test("phase2 long Pi scene includes successful, failed, and empty tool results", async () => {
  await start("chat-pi-long");
  const stream = document.querySelector(".agent-stream")?.textContent ?? "";
  expect(stream).toContain("Turn 1");
  expect(stream).toContain("Turn 12 complete");
  expect(stream).toContain("bun test chat");
  expect(stream).toContain("empty.txt");
  // The failed command is marked on its own row; the agent worked past it, so the card still reads as done.
  const steps = [...document.querySelectorAll<HTMLButtonElement>(".work-step")];
  const failed = steps.find((step) => step.textContent?.includes("bun test chat"))!;
  expect(failed.className).toContain("is-error");
  expect(failed.closest("details.work-card")?.className).toBe("work-card is-done");
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

test("the steps scene keeps routine failures off the card header and names command-output reads", async () => {
  await start("chat-steps");
  const cards = [...document.querySelectorAll<HTMLDetailsElement>("details.work-card")];
  // The agent worked past a failed read and answered: the card counts its steps.
  expect(cards[0].className).toBe("work-card is-done");
  expect(cards[0].querySelector(".work-title")?.textContent).toBe("Done · 5 steps");
  // The agent's note before its first step is a row too; only tool rows carry a target.
  const rows = [...cards[0].querySelectorAll(".work-step")].filter((row) => row.querySelector(".work-step-text"));
  expect(rows.map((row) => row.querySelector(".work-step-text")?.textContent)).toEqual([
    "cat /tmp/usage.ts +1", "Read command output", "bun /tmp/usage.ts +1", "Read command output +1", "Read command output",
  ]);
  expect(rows.map((row) => row.className.includes("is-error"))).toEqual([false, true, false, false, false]);
  expect(cards[0].textContent).not.toContain("write_stdin");
  // The last turn stopped on a failed build with no reply: that is its result.
  expect(cards[1].className).toBe("work-card is-error");
  expect(cards[1].querySelector(".work-title")?.textContent).toBe("Last step failed");
  expect(cards[1].querySelector(".work-detail")?.textContent).toBe("bun run build · 2 steps");
});

test("recorded Cursor, Hermes and opencode sessions render from the daemon's own replies", async () => {
  const card = () => document.querySelector<HTMLDetailsElement>("details.work-card")!;
  // Tool rows only: thinking and the agent's notes are rows too.
  const rows = () => [...card().querySelectorAll(".work-step")].filter((row) => row.querySelector(".work-step-text") && !row.className.includes("is-think"))
    .map((row) => `${row.className.match(/is-(read|search|edit|command|web|other|think)/)?.[1]}:${row.className.match(/is-(done|error|ended|running)/)?.[1] ?? ""}`);
  await start("chat-cursor");
  // Cursor records no results: steps are ended, the card claims nothing.
  expect(card().className).toBe("work-card is-neutral");
  expect(rows()).toEqual(["read:ended", "command:ended", "command:ended", "command:ended", "search:ended"]);
  expect(document.querySelector(".agent-user-text")?.textContent).toStartWith("Do these steps in order");
  expect(document.querySelector(".agent-stream")?.textContent).not.toContain("user_query");
  // Its step sheet says the output was not recorded rather than that there was none.
  await act(async () => { card().querySelector<HTMLButtonElement>(".work-step.is-command")!.click(); await Promise.resolve(); });
  await settle(() => Boolean(document.querySelector("dialog.step-sheet .step-empty")));
  expect(document.querySelector("dialog.step-sheet .step-empty")?.textContent).toBe("This agent does not record step output");
  closeTestDialogs();
  await select("chat-hermes");
  // Hermes reports the failed command; the agent went on to answer, so the card stays done.
  expect(card().className).toBe("work-card is-done");
  expect(rows()).toEqual(["read:done", "command:done", "command:error"]);
  await select("chat-opencode");
  expect(card().className).toBe("work-card is-done");
  expect(rows()).toEqual(["read:done", "command:done", "command:error"]);
  // A step's body comes from the recorded detail reply.
  const failed = [...card().querySelectorAll<HTMLButtonElement>(".work-step")].find((row) => row.className.includes("is-error"))!;
  await act(async () => { failed.click(); await Promise.resolve(); });
  await settle(() => (document.querySelector("dialog.step-sheet")?.textContent ?? "").includes("No such file or directory"));
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
