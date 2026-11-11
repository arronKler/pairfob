import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang, t } from "../../../lib/i18n";
import type { AgentTraceItem, AgentTraceModel } from "../../../lib/operations";
import { AgentStream } from "./agent-stream";
import { modelSummary, turnModels } from "./turn-models";
import { agentStreamSignature } from "./model";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => act(unmountReact));
const first: AgentTraceModel = { model: "gpt-5", effort: "high", source: "codex_context" };
const second: AgentTraceModel = { model: "gpt-5-mini", effort: "low", source: "codex_context" };
const empty = { kind: "empty" as const, title: "No history" };

test("each turn retains its own model beside elapsed time, steps and reply", () => {
  const turn = (text: string, model: AgentTraceModel): AgentTraceItem[] => [
    { type: "user", text, at: 1000 },
    { type: "tool", name: "Read", input: "file", output: "ok", at: 3000, models: [model] },
    { type: "assistant", text: "done", at: 73000, models: [model] },
  ];
  const paint = (items: AgentTraceItem[]) => act(() => renderReact(<AgentStream items={items} working={false} empty={empty} verified />));
  paint(turn("first", first));
  const oldCard = appRoot().querySelector(".work-card");
  paint([...turn("first", first), ...turn("second", second)]);
  const cards = [...appRoot().querySelectorAll<HTMLElement>(".work-card")];
  expect(cards[0]).toBe(oldCard);
  expect(cards[0].querySelector(".work-detail")?.textContent).toContain("gpt-5 · high");
  expect(cards[1].querySelector(".work-detail")?.textContent).toContain("gpt-5-mini · low");
  expect(cards[0].querySelector(".work-detail")?.textContent).toContain(t("work.elapsed", { time: "1 分 12 秒" }));
  expect(cards[0].querySelectorAll(".work-step")).toHaveLength(1);
  act(() => cards[0].querySelector<HTMLButtonElement>("button.work-head")!.click());
  expect(cards[0].querySelector(".fold")?.hasAttribute("inert")).toBeFalse();
  expect(cards[0].querySelector(".work-models")?.textContent).toContain(`${t("work.thinkingEffort")}high`);
  expect(appRoot().querySelectorAll(".agent-assistant-final")).toHaveLength(2);
});

test("old daemon, missing metadata and Claude's absent effort stay distinct", () => {
  expect(turnModels([{ type: "assistant", text: "legacy" }])).toBeUndefined();
  expect(modelSummary(undefined)).toBe("");
  expect(modelSummary([])).toBe(t("work.modelUnknown"));
  const claude: AgentTraceModel = { model: "claude-opus-4-1", source: "claude_message" };
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "go" }, { type: "assistant", text: "answer", models: [claude] }]}
    working={false} empty={empty} />));
  expect(appRoot().querySelector(".work-detail")?.textContent).toBe("claude-opus-4-1");
  expect(appRoot().querySelector(".work-models")?.textContent).toContain(`${t("work.thinkingEffort")}${t("work.notRecorded")}`);
  const pi: AgentTraceModel = { model: "deepseek-v4.1-flash", effort: "max", source: "pi_message" };
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "go" }, { type: "assistant", text: "answer", models: [pi] }]}
    working={false} empty={empty} />));
  expect(appRoot().querySelector(".work-detail")?.textContent).toBe("deepseek-v4.1-flash · max");
  expect(appRoot().querySelector(".work-models")?.textContent).toContain(`${t("work.thinkingEffort")}max`);
  expect(appRoot().querySelector(".work-models")?.textContent).toContain(t("work.modelPi"));
});

test("one turn keeps all distinct recorded configurations and metadata updates change the stream signature", () => {
  const items: AgentTraceItem[] = [{ type: "thinking", text: "read", models: [first] }, { type: "assistant", text: "done", models: [first, second] }];
  const models = turnModels(items);
  expect(models).toEqual([first, second]);
  expect(modelSummary(models)).toBe(t("work.multipleModels"));
  expect(agentStreamSignature(items, false, "ready", false, 0)).not.toBe(
    agentStreamSignature(items.map(item => ({ ...item, models: [] })), false, "ready", false, 0));
});
