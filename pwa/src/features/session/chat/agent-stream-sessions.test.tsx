import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang } from "../../../lib/i18n";
import { groupAgentTurns, turnKey } from "../../../lib/agent-trace-view";
import type { AgentTraceItem } from "../../../lib/operations";
import { AgentStream } from "./agent-stream";

beforeEach(async () => { await resetTestDOM(); setLang("en"); });
afterEach(() => act(unmountReact));

const empty = { kind: "empty" as const, title: "No history" };
const conversation: AgentTraceItem[] = [
  { type: "user", text: "q" },
  { type: "thinking", text: "hm" },
  { type: "assistant", text: "a" },
];
const anchors = () => [...appRoot().querySelectorAll("[data-trace-anchor]")].map(node => node.getAttribute("data-trace-anchor")!);

test("turn keys of two sessions with the same user text differ; the current session's key is unchanged", () => {
  const [turn] = groupAgentTurns(conversation);
  expect(turnKey(turn)).toBe("u:1:q:s:thinking::");
  expect(turnKey(turn, 0)).toBe("u:1:q:s:thinking::");
  expect(turnKey(turn, 1)).not.toBe(turnKey(turn, 2));
  expect(turnKey(turn, 1)).not.toBe(turnKey(turn));
});

test("anchors of an older segment carry its session index; the current session's anchors do not", () => {
  act(() => renderReact(<AgentStream items={conversation} working={false} empty={empty} />));
  const alone = anchors();
  expect(alone[0]).toBe("u:1:q:s:thinking:::user");
  act(() => renderReact(<AgentStream items={conversation} earlier={[
    { index: 2, items: conversation }, { index: 1, items: conversation },
  ]} working={false} empty={empty} />));
  const all = anchors();
  expect(new Set(all).size).toBe(all.length);
  expect(all.filter(key => key.startsWith("u:1:q"))).toEqual(alone);
  expect(all.some(key => key.startsWith("s1|"))).toBeTrue();
  expect(all.some(key => key.startsWith("s2|"))).toBeTrue();
  expect(appRoot().querySelectorAll("[role=separator]")).toHaveLength(2);
});

test("a process card's detail key is unprefixed in the current session and toggling one session's card leaves the other", () => {
  act(() => renderReact(<AgentStream items={conversation} earlier={[{ index: 1, items: conversation }]} working={false} empty={empty} />));
  const keys = [...appRoot().querySelectorAll<HTMLDetailsElement>("details.agent-process")].map(node => node.dataset.key);
  expect(keys).toEqual(["p:s1|u:1:q:s:thinking:::0", "p:u:1:q:s:thinking:::0"]);
  const [older, current] = [...appRoot().querySelectorAll<HTMLDetailsElement>("details.agent-process")];
  act(() => { older.open = true; });
  const after = [...appRoot().querySelectorAll<HTMLDetailsElement>("details.agent-process")];
  expect(after[0].dataset.user).toBe("open");
  expect(after[1].dataset.user).toBeUndefined();
  expect(current.open).toBeFalse();
});
