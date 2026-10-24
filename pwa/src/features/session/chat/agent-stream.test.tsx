import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang, t } from "../../../lib/i18n";
import type { AgentTraceItem } from "../../../lib/operations";
import { AgentStream, copiedCode } from "./agent-stream";
import { COPIED_MS } from "../copy-confirm";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => act(unmountReact));

const items: AgentTraceItem[] = [
  { type: "user", text: "Inspect this change" },
  { type: "thinking", text: "Reading\n carefully" },
  { type: "tool", name: "read_file", input: "src/app.ts", output: "file output" },
  { type: "assistant", text: "## Result\n\n**Safe** [reference](https://example.com)" },
];
const empty = { kind: "empty" as const, title: "No history" };

/** The card's head says whether its steps are open, and a press on it turns them. */
const expanded = (card: Element): boolean => card.querySelector(".work-head")?.getAttribute("aria-expanded") === "true";
function toggle(card: HTMLElement, open: boolean) {
  if (expanded(card) !== open) act(() => card.querySelector<HTMLButtonElement>("button.work-head")!.click());
}
/** What a copy button reads as: the one face of its two that is not hidden. */
const shown = (button: Element): string | null | undefined =>
  button.querySelector('.copy-ack-face[aria-hidden="false"]')?.textContent;

test("a finished turn folds its steps into a result-first card above the reply and its actions", () => {
  const copied: string[] = [];
  act(() => renderReact(<AgentStream items={items} working={false} empty={empty} verified
    onCopyReply={text => { copied.push(text); }} onTerminal={() => {}} />));
  expect(appRoot().querySelector(".agent-user-text")?.textContent).toBe(items[0].text);
  const card = appRoot().querySelector<HTMLElement>(".work-card")!;
  expect(expanded(card)).toBeFalse();
  expect(card.className).toBe("work-card is-done");
  expect(card.querySelector(".work-title")?.textContent).toBe(t("work.doneSteps", { n: 1 }));
  expect(appRoot().querySelectorAll(".work-step")).toHaveLength(2);
  expect(appRoot().querySelector(".agent-md h2")?.textContent).toBe("Result");
  expect(appRoot().querySelector(".agent-md strong")?.textContent).toBe("Safe");
  const link = appRoot().querySelector(".agent-md a")!;
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(appRoot().querySelectorAll(".agent-reply-copy")).toHaveLength(1);
  act(() => appRoot().querySelector<HTMLButtonElement>(".agent-reply-copy")!.click());
  // Mode switching lives in the session menu; a reply only offers copy.
  expect(appRoot().querySelector(".agent-reply-actions")?.querySelectorAll("button")).toHaveLength(1);
  expect(copied).toEqual([items[3].text!]);
});

test("without verified failure states a finished card stays neutral instead of claiming success", () => {
  act(() => renderReact(<AgentStream items={items} working={false} empty={empty} />));
  expect(appRoot().querySelector(".work-card")?.className).toBe("work-card is-neutral");
  expect(appRoot().querySelector(".work-step.is-read")?.className).toContain("is-ended");
});

test("the card leads with changed files past a routine failure, and step rows open their sheet", () => {
  const opened: AgentTraceItem[] = [];
  const turn: AgentTraceItem[] = [
    { type: "user", text: "fix" },
    { type: "tool", name: "Edit", label: "src/app/boot.ts", toolState: "done", detailRef: "e1" },
    { type: "tool", name: "Bash", label: "bun test", toolState: "error", detailRef: "b1" },
    { type: "assistant", text: "One test still fails." },
  ];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified onOpenStep={item => opened.push(item)} />));
  const card = appRoot().querySelector<HTMLElement>(".work-card")!;
  expect(card.className).toBe("work-card is-done");
  expect(card.querySelector(".work-title")?.textContent).toBe(t("work.changedFiles", { n: 1 }));
  expect(card.querySelector(".work-detail")?.textContent).toBe(`boot.ts · ${t("work.total", { n: 2 })}`);
  const rows = [...card.querySelectorAll<HTMLButtonElement>(".work-step")];
  expect(rows.map(row => row.querySelector(".work-step-text")?.textContent)).toEqual(["app/boot.ts", "bun test"]);
  expect(rows[1].getAttribute("aria-label")).toBe(t("work.stepAria", { category: t("work.cat.command"), object: "bun test", state: t("work.state.error") }));
  act(() => rows[1].click());
  expect(opened.map(item => item.detailRef)).toEqual(["b1"]);
});

test("a folded run keeps the card's verified state, so an unverified agent reads as ended, not done", () => {
  // Three reads: enough to fold, all settled.
  const turn: AgentTraceItem[] = [{ type: "user", text: "inspect" },
    { type: "tool", name: "Read", label: "a.go", toolState: "done" },
    { type: "tool", name: "Read", label: "b.go", toolState: "done" },
    { type: "tool", name: "Read", label: "c.go", toolState: "done" },
    { type: "assistant", text: "Nothing there." }];
  // Verified: each row inside the run claims its own success.
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  act(() => appRoot().querySelector<HTMLButtonElement>(".work-folded-head")!.click());
  expect([...appRoot().querySelectorAll(".work-folded-steps .work-step")].map((row) => row.className))
    .toEqual(["work-step is-read is-done", "work-step is-read is-done", "work-step is-read is-done"]);
  act(unmountReact);
  // Unverified: the same rows end without claiming a result they cannot know.
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} />));
  act(() => appRoot().querySelector<HTMLButtonElement>(".work-folded-head")!.click());
  expect([...appRoot().querySelectorAll(".work-folded-steps .work-step")].map((row) => row.className))
    .toEqual(["work-step is-read is-ended", "work-step is-read is-ended", "work-step is-read is-ended"]);
});

test("a step pressed inside a folded run opens that step, at its own place in the card's list", () => {
  const opened: AgentTraceItem[] = [];
  const turn: AgentTraceItem[] = [
    { type: "user", text: "inspect" },
    { type: "assistant", text: "I will read all three." },
    { type: "tool", name: "Read", label: "a.go", toolState: "done", detailRef: "r1" },
    { type: "tool", name: "Read", label: "b.go", toolState: "done", detailRef: "r2" },
    { type: "tool", name: "Read", label: "c.go", toolState: "done", detailRef: "r3" },
    { type: "assistant", text: "Done." },
  ];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified onOpenStep={(item, steps) => {
    opened.push(item);
    // The list the sheet pages is the card's own rows: the finding is not in it.
    expect(steps?.map((step) => step.detailRef ?? step.type)).toEqual(["r1", "r2", "r3"]);
    expect(opened.at(-1)!.detailRef).toBe("r3");
  }} />));
  act(() => appRoot().querySelector<HTMLButtonElement>(".work-folded-head")!.click());
  const rows = [...appRoot().querySelectorAll<HTMLButtonElement>(".work-folded-steps .work-step")];
  expect(rows).toHaveLength(3);
  act(() => rows[2]!.click());
  expect(opened.map((item) => item.detailRef)).toEqual(["r3"]);
});

test("an 'other' tool never folds, even in a run of its own kind", () => {
  const turn: AgentTraceItem[] = [{ type: "user", text: "go" },
    { type: "tool", name: "mcp_call", label: "one", toolState: "done", detailRef: "o1" },
    { type: "tool", name: "mcp_call", label: "two", toolState: "done", detailRef: "o2" },
    { type: "tool", name: "mcp_call", label: "three", toolState: "done", detailRef: "o3" },
    { type: "assistant", text: "Done." }];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  // Its rows carry no category to name a run by, so each stays its own row.
  expect(appRoot().querySelector(".work-folded")).toBeNull();
  expect([...appRoot().querySelectorAll(".work-step.is-other .work-step-text")].map((node) => node.textContent))
    .toEqual(["one", "two", "three"]);
});

test("a finding opens on its own page, not as the first item of the tool pager", () => {
  const finding = "The snapshot keeps no URL.";
  const turn: AgentTraceItem[] = [{ type: "user", text: "inspect" },
    { type: "tool", name: "Read", label: "a.go", toolState: "done", detailRef: "r1" },
    { type: "tool", name: "Read", label: "b.go", toolState: "done", detailRef: "r2" },
    { type: "tool", name: "Read", label: "c.go", toolState: "done", detailRef: "r3" },
    // A step after the finding keeps it in the turn's entries, so it draws a bubble.
    { type: "assistant", text: finding },
    { type: "tool", name: "Edit", label: "a.go", toolState: "done", detailRef: "e1" },
    { type: "assistant", text: "Fixed." }];
  let opened: { item: AgentTraceItem; steps?: AgentTraceItem[] } | null = null;
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified
    onOpenStep={(item, steps) => { opened = { item, steps }; }} />));
  const bubble = appRoot().querySelector<HTMLButtonElement>(".agent-finding-body")!;
  act(() => bubble.click());
  // The finding is not one of the card's rows, so the press carries the card's
  // tool list; `openStepSheet` drops it and pages the finding alone.
  expect(opened!.item.text).toBe(finding);
  expect(opened!.steps!.map((step) => step.detailRef ?? step.type)).toEqual(["r1", "r2", "r3", "e1"]);
  expect(opened!.steps!.includes(opened!.item)).toBe(false);
});

test("a turn's finding stands on its own between the steps and the reply", () => {
  const finding = "The snapshot keeps no URL, so the character photo is lost at submit.";
  const turn: AgentTraceItem[] = [
    { type: "user", text: "inspect" },
    { type: "tool", name: "Read", label: "gen.go", toolState: "done", detailRef: "r1" },
    { type: "assistant", text: finding },
    { type: "tool", name: "Edit", label: "gen.go", toolState: "done", detailRef: "e1" },
    { type: "assistant", text: "Fixed." },
  ];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  const card = appRoot().querySelector<HTMLElement>(".work-card")!;
  const bubble = appRoot().querySelector<HTMLElement>(".agent-finding")!;
  // The card holds steps alone: no step row repeats the finding.
  expect(card.querySelector(".agent-finding")).toBeNull();
  expect([...card.querySelectorAll(".work-step-text")].map((node) => node.textContent)).toEqual(["gen.go", "gen.go"]);
  // The finding is its own message, between the card and the reply, in order.
  expect(bubble.textContent).toContain(finding);
  expect(Boolean(card.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  const reply = appRoot().querySelector(".agent-assistant-final")!;
  expect(Boolean(bubble.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test("a manual collapse of a live card survives new output and keeps its card node", () => {
  const paint = (text: string) => act(() => renderReact(<AgentStream items={[...items.slice(0, 3), { type: "assistant", text }]}
    working empty={empty} />));
  paint("first partial reply");
  const card = appRoot().querySelector<HTMLElement>(".work-card")!;
  expect(expanded(card)).toBeTrue();
  toggle(card, false);
  expect(card.dataset.user).toBe("closed");
  paint("second partial reply");
  expectSameNode(appRoot().querySelector(".work-card"), card);
  expect(expanded(card)).toBeFalse();
  expect(card.querySelector(".work-title")?.textContent).toBe(t("work.running", { n: 1 }));
  // While running, the latest note sits under the card and nothing offers a copy yet.
  expect(appRoot().querySelector(".agent-assistant-intermediate")?.textContent).toContain("second partial reply");
  expect(appRoot().querySelector(".agent-reply-copy")).toBeNull();
});

test("a live card shows every step as itself, and a finished one folds the run", () => {
  const many: AgentTraceItem[] = [{ type: "user", text: "go" },
    ...Array.from({ length: 7 }, (_, index): AgentTraceItem => ({ type: "tool", name: "Read", label: `f${index}.ts`, toolState: "done" })),
    { type: "assistant", text: "done" }];
  act(() => renderReact(<AgentStream items={many.slice(0, 8)} working empty={empty} />));
  // Running: the window keeps four rows and no run folds under the reader, so
  // the steps they just watched arrive stay visible.
  expect([...appRoot().querySelectorAll(".work-step-text")].map(node => node.textContent)).toEqual(["f3.ts", "f4.ts", "f5.ts", "f6.ts"]);
  expect(appRoot().querySelector(".work-folded")).toBeNull();
  act(() => appRoot().querySelector<HTMLButtonElement>(".work-earlier")!.click());
  expect(appRoot().querySelectorAll(".work-step")).toHaveLength(7);
  act(unmountReact);
  // Finished: the same seven reads are one run, one row naming the count.
  act(() => renderReact(<AgentStream items={many} working={false} empty={empty} />));
  const folded = appRoot().querySelector<HTMLButtonElement>(".work-folded-head")!;
  expect(folded.getAttribute("aria-label")).toContain(t("work.folded", { category: t("work.cat.read"), n: 7 }));
  expect(folded.querySelector(".work-folded-count")?.textContent).toBe(t("work.foldedCount", { n: 7 }));
  expect(appRoot().querySelectorAll(".work-step")).toHaveLength(1);
  act(() => folded.click());
  expect(appRoot().querySelectorAll(".work-step.is-read")).toHaveLength(7);
});

test("a blocked agent raises the needs-you card with what it waits to run", () => {
  let exits = 0;
  const turn: AgentTraceItem[] = [{ type: "user", text: "clean up" }, { type: "tool", name: "Bash", label: "rm -rf pwa/dist", toolState: "running" }];
  act(() => renderReact(<AgentStream items={turn} working waiting empty={empty} onTerminal={() => { exits++; }} />));
  expect(appRoot().querySelector(".work-card")?.className).toBe("work-card is-waiting");
  const needs = appRoot().querySelector(".needs-card")!;
  expect(needs.querySelector(".needs-verb")?.textContent).toBe(t("needs.run"));
  expect(needs.querySelector(".needs-object")?.textContent).toBe("rm -rf pwa/dist");
  act(() => needs.querySelector<HTMLButtonElement>(".needs-go")!.click());
  expect(exits).toBe(1);
});

test("an agent that stops to ask before any step shows only the needs-you card", () => {
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "ship it" }]} working waiting empty={empty} />));
  expect(appRoot().querySelector(".work-card")).toBeNull();
  expect(appRoot().querySelector(".needs-card")).not.toBeNull();
});

test("a lost connection freezes the live card instead of spinning", () => {
  act(() => renderReact(<AgentStream items={items.slice(0, 3)} working stale empty={empty} />));
  const card = appRoot().querySelector(".work-card")!;
  expect(card.className).toBe("work-card is-stale");
  expect(card.querySelector(".work-head .spinner")).toBeNull();
});

test("a pending prompt carries its delivery state in its own turn", () => {
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "/model opus", pending: true }]} working={false} empty={empty}
    progress={{ message: t("pending.local"), attention: false, settled: true }} />));
  const pending = appRoot().querySelector("[data-prompt-progress]")!;
  expect(pending.className).toBe("pending-card");
  expect(pending.textContent).toBe(t("pending.local"));
  expect(pending.querySelector(".spinner")).toBeNull();
  expect(appRoot().querySelector(".work-card")).toBeNull();
});

test("attachment paths become chips and long prompts fold", () => {
  const text = "Look at this\n\n/Users/me/repo/.pairfob/attachments/0f1e/shot.png";
  act(() => renderReact(<AgentStream items={[{ type: "user", text }]} working={false} empty={empty} />));
  expect(appRoot().querySelector(".agent-user-text")?.textContent).toBe("Look at this");
  expect([...appRoot().querySelectorAll(".agent-user-files li")].map(node => node.textContent)).toEqual(["shot.png"]);
});

test("duplicate prompts remain separate turns and unsafe Markdown cannot introduce active elements", () => {
  const turns: AgentTraceItem[] = [
    { type: "user", text: "again" }, { type: "assistant", text: "first" },
    { type: "user", text: "again" }, { type: "assistant", text: '<script>alert(1)</script>\n\n[x](javascript:alert(1))' },
  ];
  act(() => renderReact(<AgentStream items={turns} working={false} empty={empty} />));
  expect(appRoot().querySelectorAll(".agent-user")).toHaveLength(2);
  expect(appRoot().querySelectorAll(".agent-assistant-final")).toHaveLength(2);
  const repeated = [...appRoot().querySelectorAll<HTMLElement>(".agent-user")];
  expect(repeated.map((node) => node.dataset.traceOrdinal)).toEqual(["0", "1"]);
  expect(repeated.map((node) => node.dataset.traceOrdinalEnd)).toEqual(["1", "0"]);
  expect(repeated[0].dataset.traceAnchor).toBe(repeated[1].dataset.traceAnchor);
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

test("unavailable history keeps its terminal action beside a pending prompt without fake activity", () => {
  let exits = 0;
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "Already sent" }]} working
    empty={{ kind: "unavailable", title: "Cannot read", sub: "See terminal" }} onTerminal={() => { exits++; }} />));
  expect(appRoot().textContent).toContain("Already sent");
  expect(appRoot().textContent).toContain("Cannot read");
  expect(appRoot().querySelector(".work-card")).toBeNull();
  act(() => appRoot().querySelector<HTMLButtonElement>(".agent-open-terminal")!.click());
  expect(exits).toBe(1);
});

test("commands render as chips; interrupts mark the card and compaction stays a divider", () => {
  act(() => renderReact(<AgentStream items={[
    { type: "command", text: "/clear" },
    { type: "user", text: "fix it" },
    { type: "tool", name: "Read", input: "{}", output: "ok" },
    { type: "compaction" },
    { type: "assistant", text: "partial" },
    { type: "interrupt" },
  ]} working={false} empty={empty} />));
  const command = appRoot().querySelector(".agent-command")!;
  expect(command.querySelector(".agent-command-text")?.textContent).toBe("/clear");
  expect(command.getAttribute("aria-label")).toBe(t("trace.commandAria", { cmd: "/clear" }));
  expect(appRoot().querySelectorAll(".agent-user")).toHaveLength(1);
  expect(appRoot().querySelector(".agent-md")?.textContent).toContain("partial");
  const card = appRoot().querySelector(".work-card")!;
  expect(card.className).toBe("work-card is-interrupted");
  expect(card.querySelector(".work-title")?.textContent).toBe(t("work.interrupted"));
  // The transcript opens with /clear, so a new-session divider leads it.
  expect([...appRoot().querySelectorAll(".agent-marker")].map((node) => node.textContent)).toEqual([t("chat.newSession"), t("trace.compacted")]);
});

test("a finished card says how long the turn took when the daemon stamps records", () => {
  act(() => renderReact(<AgentStream items={[
    { type: "user", text: "go", at: 1_000 },
    { type: "tool", name: "Read", label: "a.ts", toolState: "done", at: 2_000 },
    { type: "assistant", text: "done", at: 186_000 },
  ]} working={false} verified empty={empty} />));
  expect(appRoot().querySelector(".work-detail")?.textContent)
    .toBe(`${t("work.elapsed", { time: t("time.minutes", { m: 3, s: 5 }) })}`);
});

test("a turn interrupted by a new message says the work continues there", () => {
  act(() => renderReact(<AgentStream items={[
    { type: "user", text: "first" }, { type: "tool", name: "Read", label: "a.ts", toolState: "done" },
    { type: "user", text: "also check b" }, { type: "tool", name: "Read", label: "b.ts", toolState: "done" },
  ]} working={false} verified empty={empty} />));
  const details = [...appRoot().querySelectorAll(".work-detail")].map((node) => node.textContent);
  expect(details[0]).toBe(t("work.continued"));
  expect(details[1]).toContain(t("work.noReply", { step: "b.ts" }));
});

test("only a turn that stopped on a failed step leads with the failure, and names the step", () => {
  act(() => renderReact(<AgentStream items={[
    { type: "user", text: "first" }, { type: "tool", name: "Bash", label: "bun test", toolState: "error" },
    { type: "tool", name: "Read", label: "a.ts", toolState: "done" }, { type: "assistant", text: "Fixed." },
    { type: "user", text: "again" }, { type: "tool", name: "Read", label: "b.ts", toolState: "done" },
    { type: "tool", name: "Bash", label: "bun test", toolState: "error" },
  ]} working={false} verified empty={empty} />));
  const cards = [...appRoot().querySelectorAll(".work-card")];
  expect(cards.map((card) => card.className)).toEqual(["work-card is-done", "work-card is-error"]);
  expect(cards[0].querySelector(".work-title")?.textContent).toBe(t("work.doneSteps", { n: 2 }));
  expect(cards[1].querySelector(".work-title")?.textContent).toBe(t("work.endedFailed"));
  expect(cards[1].querySelector(".work-detail")?.textContent).toBe(`bun test · ${t("work.total", { n: 2 })}`);
});

test("a headless first turn with older pages says earlier steps are not loaded", () => {
  act(() => renderReact(<AgentStream items={[{ type: "tool", name: "Read", label: "a.ts", toolState: "done" }, { type: "assistant", text: "ok" }]}
    working={false} hasOlder verified empty={empty} />));
  expect(appRoot().querySelector(".work-detail")?.textContent).toContain(t("work.partial"));
});

test("a transcript that starts with /clear opens with a new-session divider", () => {
  const items: AgentTraceItem[] = [{ type: "command", text: "/clear" }, { type: "user", text: "hi" }, { type: "assistant", text: "hello" }];
  act(() => renderReact(<AgentStream items={items} working={false} empty={empty} />));
  expect(appRoot().querySelector(".agent-new-session")?.textContent).toBe(t("chat.newSession"));
  act(() => renderReact(<AgentStream items={items} working={false} hasOlder empty={empty} />));
  expect(appRoot().querySelector(".agent-new-session")).toBeNull();
});

test("long cards filter to failed or edited steps", () => {
  const steps: AgentTraceItem[] = Array.from({ length: 9 }, (_, index): AgentTraceItem => ({ type: "tool", name: index % 3 ? "Read" : "Edit",
    label: `f${index}.ts`, toolState: index === 4 ? "error" : "done" }));
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "go" }, ...steps, { type: "assistant", text: "done" }]} working={false} verified empty={empty} />));
  const chips = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".work-filter")];
  expect(chips().map((chip) => chip.textContent)).toEqual([t("work.filterAll"), t("work.filterFailed", { n: 1 }), t("work.filterEdits", { n: 3 })]);
  act(() => chips()[1].click());
  expect([...appRoot().querySelectorAll(".work-step-text")].map((node) => node.textContent)).toEqual(["f4.ts"]);
  act(() => chips()[2].click());
  expect(appRoot().querySelectorAll(".work-step")).toHaveLength(3);
});

test("a card that finishes while the reader is scrolled up stays open until they return", () => {
  const live: AgentTraceItem[] = [{ type: "user", text: "go" }, { type: "tool", name: "Read", label: "a.ts", toolState: "done" }];
  const paint = (working: boolean, follow: boolean, extra: AgentTraceItem[] = []) =>
    act(() => renderReact(<AgentStream items={[...live, ...extra]} working={working} follow={follow} empty={empty} />));
  paint(true, false);
  const card = () => appRoot().querySelector<HTMLElement>(".work-card")!;
  expect(expanded(card())).toBeTrue();
  paint(false, false, [{ type: "assistant", text: "done" }]);
  expect(expanded(card())).toBeTrue();
  paint(false, true, [{ type: "assistant", text: "done" }]);
  expect(expanded(card())).toBeFalse();
});

test("code blocks in a final reply get their own copy button", () => {
  const copied: Array<[string, string | undefined]> = [];
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "q" }, { type: "assistant", text: "Run:\n\n```sh\nbun test\n```" }]}
    working={false} empty={empty} onCopyReply={(text, what) => { copied.push([text, what]); }} />));
  const button = appRoot().querySelector<HTMLButtonElement>(".md-code .md-copy")!;
  expect(shown(button)).toBe(t("reply.copyCode"));
  act(() => button.click());
  // Without the line break that ends the block: pasted into a shell, it would run the line.
  expect(copied).toEqual([["bun test", "code"]]);
});

test("every copy press copies what was pressed and is confirmed on that button, then the button is itself again", async () => {
  const copied: string[] = [];
  const text = "One:\n\n```sh\nfirst\n```\n\nTwo:\n\n```sh\nsecond\n```";
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "q" }, { type: "assistant", text }]}
    working={false} empty={empty} onCopyReply={async (value) => { copied.push(value); return true; }} />));
  const [first, second] = [...appRoot().querySelectorAll<HTMLButtonElement>(".md-code .md-copy")];
  const reply = appRoot().querySelector<HTMLButtonElement>(".agent-reply-copy")!;
  const labels = () => [first, second, reply].map(shown);
  const press = async (button: HTMLButtonElement) => await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
  await press(first);
  expect(labels()).toEqual([t("reply.copied"), t("reply.copyCode"), t("reply.copy")]);
  expect(first.getAttribute("aria-label")).toBe(t("chat.copiedCode"));
  // Straight on to the next block and to the reply's own button: nothing in between holds a press back.
  await press(second);
  await press(reply);
  expect(copied).toEqual(["first", "second", text]);
  expect(labels()).toEqual([t("reply.copied"), t("reply.copied"), t("reply.copied")]);
  expect(reply.getAttribute("aria-label")).toBe(t("chat.copiedReply"));
  expectSameNode(appRoot().querySelector(".agent-reply-copy"), reply);
  expectSameNode(appRoot().querySelector(".md-code .md-copy"), first);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, COPIED_MS + 60)); });
  expect(labels()).toEqual([t("reply.copyCode"), t("reply.copyCode"), t("reply.copy")]);
  expect([first.getAttribute("aria-label"), first.querySelector(".copy-ack")?.getAttribute("data-state"), reply.getAttribute("aria-label")])
    .toEqual([null, "idle", t("chat.copyReplyAria")]);
});

test("a copy the browser refused leaves the pressed button as it was", async () => {
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "q" }, { type: "assistant", text: "```sh\nbun test\n```" }]}
    working={false} empty={empty} onCopyReply={async () => false} />));
  const code = appRoot().querySelector<HTMLButtonElement>(".md-code .md-copy")!;
  const reply = appRoot().querySelector<HTMLButtonElement>(".agent-reply-copy")!;
  await act(async () => { code.click(); reply.click(); await Promise.resolve(); await Promise.resolve(); });
  expect([shown(code), shown(reply)]).toEqual([t("reply.copyCode"), t("reply.copy")]);
});

test("copied code keeps the line breaks inside it and drops only the one that ends the block", () => {
  expect(copiedCode("git status\ngit diff\n")).toBe("git status\ngit diff");
  expect(copiedCode("a\n\nb\r\n")).toBe("a\n\nb");
  // A blank last line the author wrote is theirs: one break goes, not all of them.
  expect(copiedCode("a\n\n")).toBe("a\n");
  expect(copiedCode("no break")).toBe("no break");
  const copied: string[] = [];
  act(() => renderReact(<AgentStream items={[{ type: "user", text: "q" }, { type: "assistant", text: "```sh\ngit status\ngit diff\n```" }]}
    working={false} empty={empty} onCopyReply={(text) => { copied.push(text); }} />));
  act(() => appRoot().querySelector<HTMLButtonElement>(".md-code .md-copy")!.click());
  expect(copied).toEqual(["git status\ngit diff"]);
});

test("a one-line block is one row with its button; several lines, or a line too long for that row, keep a strip above", () => {
  const reply = (text: string) => [{ type: "user" as const, text: "q" }, { type: "assistant" as const, text }];
  const paintReply = (text: string): void => {
    act(() => renderReact(<AgentStream items={reply(text)} working={false} empty={empty} onCopyReply={() => undefined} />));
  };
  paintReply("```sh\nbun test\n```\n\nthen\n\n```sh\ngit status\ngit diff\n```");
  const frames = () => [...appRoot().querySelectorAll<HTMLElement>(".md-code")];
  expect(frames().map((frame) => frame.classList.contains("is-inline"))).toEqual([true, false]);
  act(() => unmountReact());
  // A test DOM lays nothing out: stand in for a line that scrolls in the one-row form.
  const proto = window.HTMLElement.prototype;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.tagName === "PRE" ? 932 : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.tagName === "PRE" ? 360 : 0; } });
  try {
    paintReply("```sh\npairfob daemon --origin https://pairfob.com --log-level debug --no-color\n```");
    expect(frames().map((frame) => frame.classList.contains("is-inline"))).toEqual([false]);
  } finally {
    if (scroll) Object.defineProperty(proto, "scrollWidth", scroll); else Reflect.deleteProperty(proto, "scrollWidth");
    if (client) Object.defineProperty(proto, "clientWidth", client); else Reflect.deleteProperty(proto, "clientWidth");
  }
});

test("a code block keeps its copy button, and its own node, through later renders of the same reply", () => {
  // React writes innerHTML again for every new `{ __html }` object. The stream
  // re-renders on any store change, so the button lasted until the first one.
  const items = [{ type: "user" as const, text: "q" }, { type: "assistant" as const, text: "Run:\n\n```sh\nbun test\n```" }];
  const copied: string[] = [];
  const onCopy = (text: string): void => { copied.push(text); };
  const paintAgain = (follow: boolean): void => {
    act(() => renderReact(<AgentStream items={items} working={false} empty={empty} follow={follow} onCopyReply={onCopy} />));
  };
  paintAgain(true);
  const pre = appRoot().querySelector(".agent-md pre")!;
  expect(appRoot().querySelectorAll(".md-code .md-copy")).toHaveLength(1);
  // The same reply, rendered again for something else that changed.
  paintAgain(false);
  paintAgain(true);
  expect(appRoot().querySelectorAll(".md-code .md-copy")).toHaveLength(1);
  // Not rebuilt: a selection the reader made in the reply is still in the document.
  expectSameNode(appRoot().querySelector(".agent-md pre"), pre);
  act(() => appRoot().querySelector<HTMLButtonElement>(".md-code .md-copy")!.click());
  expect(copied).toEqual(["bun test"]);
});

test("a reply that changes gets the button on its new code block, once", () => {
  const paintReply = (text: string): void => {
    act(() => renderReact(<AgentStream items={[{ type: "user", text: "q" }, { type: "assistant", text }]}
      working={false} empty={empty} onCopyReply={() => undefined} />));
  };
  paintReply("Run:\n\n```sh\nbun test\n```");
  paintReply("Run:\n\n```sh\nbun test\n```\n\nthen\n\n```sh\nbun run build\n```");
  expect(appRoot().querySelectorAll(".agent-md pre")).toHaveLength(2);
  expect(appRoot().querySelectorAll(".md-code")).toHaveLength(2);
  expect(appRoot().querySelectorAll(".md-code .md-copy")).toHaveLength(2);
});

test("a reply still being written has no copy button until it is final, and then it does", () => {
  const items = [{ type: "user" as const, text: "q" }, { type: "assistant" as const, text: "```sh\nbun test\n```" }];
  const paintWorking = (working: boolean): void => {
    act(() => renderReact(<AgentStream items={items} working={working} empty={empty} onCopyReply={() => undefined} />));
  };
  paintWorking(true);
  expect(appRoot().querySelectorAll(".md-copy")).toHaveLength(0);
  paintWorking(false);
  expect(appRoot().querySelectorAll(".md-code .md-copy")).toHaveLength(1);
});

test("a final reply of nothing but space leaves no blank bubble to focus", () => {
  const turn: AgentTraceItem[] = [{ type: "user", text: "go" },
    { type: "tool", name: "Read", label: "a.go", toolState: "done", detailRef: "r1" },
    { type: "assistant", text: "   " }];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  expect(appRoot().querySelector(".agent-assistant")).toBeNull();
  expect(appRoot().querySelectorAll(".agent-assistant button")).toHaveLength(0);
});

test("a finding spoken before the first step introduces the work, above the card", () => {
  const turn: AgentTraceItem[] = [{ type: "user", text: "inspect" },
    { type: "assistant", text: "I'll take a look first." },
    { type: "tool", name: "Read", label: "a.go", toolState: "done", detailRef: "r1" },
    { type: "assistant", text: "Found it." },
    { type: "tool", name: "Edit", label: "a.go", toolState: "done", detailRef: "e1" },
    { type: "assistant", text: "Fixed." }];
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  const card = appRoot().querySelector<HTMLElement>(".work-card")!;
  const [intro, between] = [...appRoot().querySelectorAll<HTMLElement>(".agent-finding")];
  // The one that opens the turn stands before the work it introduces.
  expect(intro!.textContent).toContain("I'll take a look first.");
  expect(Boolean(intro!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  // The one spoken mid-run stays after the card, where it was said.
  expect(between!.textContent).toContain("Found it.");
  expect(Boolean(card.compareDocumentPosition(between!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test("a finished turn with more runs than the window keeps four rows, and reveals whole runs", () => {
  // Five alternating runs of three: the case where a group count and a step
  // offset disagree. The window holds four rows, and each row is a whole run.
  const kinds = ["Read", "Bash", "Read", "Bash", "Read"];
  const turn: AgentTraceItem[] = [{ type: "user", text: "go" }];
  kinds.forEach((name, run) => {
    for (let i = 0; i < 3; i += 1) {
      turn.push({ type: "tool", name, label: `${name.toLowerCase()}-${run}-${i}`, toolState: "done", detailRef: `d${run}${i}` });
    }
  });
  turn.push({ type: "assistant", text: "Done." });
  act(() => renderReact(<AgentStream items={turn} working={false} empty={empty} verified />));
  act(() => appRoot().querySelector<HTMLButtonElement>("button.work-head")!.click());
  const rows = () => [...appRoot().querySelectorAll(".work-steps:not(.work-steps-pushed) > li")];
  // Four rows for the five runs, and every row is a whole run of three.
  expect(rows()).toHaveLength(4);
  expect(rows().every((row) => row.querySelector(".work-folded-count")?.textContent === t("work.foldedCount", { n: 3 }))).toBe(true);
  // The disclosure names the steps the hidden run holds, not the rows it stood for.
  const earlier = appRoot().querySelector<HTMLButtonElement>(".work-earlier")!;
  expect(earlier.textContent).toBe(t("work.earlier", { n: 3 }));
  act(() => earlier.click());
  expect(rows()).toHaveLength(5);
});
