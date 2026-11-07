import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { AgentStream } from "./agent-stream";

beforeEach(async () => { await resetTestDOM(); setLang("en"); });
afterEach(async () => {
  await act(unmountReact);
  setLang("zh");
});

const empty = { kind: "empty" as const, title: "No history" };

function trace(turns: number, detail = false): AgentTraceItem[] {
  const out: AgentTraceItem[] = [];
  for (let n = 1; n <= turns; n += 1) {
    out.push({ type: "user", text: `turn ${n}` });
    out.push(detail ? { type: "tool", name: "read_file", input: `f${n}.ts`, detailRef: `ref-${n}` }
      : { type: "tool", name: "read_file", input: `f${n}.ts`, output: "ok" });
    out.push({ type: "assistant", text: `answer **${n}**` });
  }
  return out;
}

const users = () => [...document.querySelectorAll(".agent-user")].map(node => node.textContent);

test("100 finished turns render the last 20, and the button shows 20 more in source order", () => {
  act(() => renderReact(<AgentStream items={trace(100)} working={false} empty={empty} />));
  expect(users()).toHaveLength(20);
  expect(users().at(-1)).toBe("turn 100");
  expect(users()[0]).toBe("turn 81");
  act(() => { document.querySelector<HTMLButtonElement>(".agent-show-earlier")!.click(); });
  expect(users()).toHaveLength(40);
  expect(users().at(-1)).toBe("turn 100");
  expect(users()).toEqual(Array.from({ length: 40 }, (_, i) => `turn ${61 + i}`));
});

test("appending a turn leaves the DOM of finished turns untouched, with a new toolDetail closure per render", async () => {
  const base = trace(100, true);
  const paint = (items: AgentTraceItem[]) => act(() => renderReact(<AgentStream items={items} working={false} empty={empty}
    toolDetail={() => ({ status: "idle" })} onNeedToolDetail={() => {}} />));
  paint(base);
  const before = [...document.querySelectorAll(".agent-md")];
  expect(before).toHaveLength(20);
  const stream = document.querySelector(".agent-stream")!;
  const records: MutationRecord[] = [];
  const observer = new (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver(list => records.push(...list));
  observer.observe(stream, { subtree: true, childList: true, characterData: true, attributes: true });
  paint([...base.map(item => ({ ...item })), { type: "user", text: "turn 101" }, { type: "assistant", text: "fresh" }]);
  await Promise.resolve();
  records.push(...observer.takeRecords());
  observer.disconnect();
  const after = [...document.querySelectorAll(".agent-md")];
  // The window slides by one: the first rendered turn leaves, the previous last and the new one render.
  const stable = before.slice(1, -1);
  for (const node of stable) {
    expect(after).toContain(node);
    expect(records.some(record => node.contains(record.target))).toBeFalse();
  }
});
