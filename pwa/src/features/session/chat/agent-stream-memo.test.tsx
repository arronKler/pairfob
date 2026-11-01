import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { marked } from "marked";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { AgentStream } from "./agent-stream";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => act(unmountReact));

const empty = { kind: "empty" as const, title: "No history" };

function trace(turns: number): AgentTraceItem[] {
  const out: AgentTraceItem[] = [];
  for (let n = 0; n < turns; n += 1) {
    out.push({ type: "user", text: `question ${n}` });
    out.push({ type: "tool", name: "read_file", input: `f${n}.ts`, output: "ok" });
    out.push({ type: "assistant", text: `answer **${n}**` });
  }
  return out;
}

function render(items: AgentTraceItem[]) {
  act(() => renderReact(<AgentStream items={items} working={false} empty={empty} />));
}

test("appending one reply to a finished 100-turn trace parses only the new reply", () => {
  const base = trace(100);
  render(base);
  const parse = spyOn(marked, "parse");
  try {
    // Fresh item objects with the same content, as a refetch would produce.
    render([...base.map(item => ({ ...item })), { type: "user", text: "next" }, { type: "assistant", text: "fresh **reply**" }]);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    parse.mockRestore();
  }
});

test("a language change re-renders the copy label of finished turns", () => {
  const items: AgentTraceItem[] = [{ type: "user", text: "q" }, { type: "assistant", text: "a" }];
  const view = (lang: number) => <AgentStream key="s" items={items} working={false} empty={empty} onCopyReply={() => {}} signature={String(lang)} />;
  setLang("zh");
  act(() => renderReact(view(0)));
  const before = document.querySelector(".agent-reply-copy")?.textContent;
  setLang("en");
  act(() => renderReact(view(1)));
  expect(document.querySelector(".agent-reply-copy")?.textContent).not.toBe(before);
});
