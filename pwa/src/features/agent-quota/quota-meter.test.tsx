import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode, expectSameNodes } from "../../../test-support/node-identity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { compileScss } from "../../../test-support/compiled-style";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { setLang } from "../../lib/i18n";
import type { QuotaModuleModel, QuotaModuleRow } from "./model";
import { QuotaModuleView } from "./quota-module-view";

/**
 * What moves in the quota meters, and what must not: a meter that has just
 * been read arrives, a refreshed share travels and its number is swapped in,
 * and a module drawn with its data, or drawn again with the same data, is still.
 */
const css = compileScss(new URL("./styles/quota.scss", import.meta.url)).css.replace(/\/\*[\s\S]*?\*\//g, "");
const row = (provider: string, remaining: number): QuotaModuleRow => ({
  id: provider, provider: provider as QuotaModuleRow["provider"], name: provider, sub: "5h",
  meter: { kind: "limited", remaining, tone: "ok" as never, aria: `${provider} ${remaining}` },
});
const ready = (...rows: QuotaModuleRow[]): QuotaModuleModel => ({ state: "ready", rows, total: rows.length, attention: 0, updated: "just now" });
const loading: QuotaModuleModel = { state: "loading", rows: [], total: 0, attention: 0, updated: null };
const draw = (model: QuotaModuleModel) => renderReact(<QuotaModuleView model={model} onOpen={() => {}} />);
const meters = () => [...document.querySelectorAll<HTMLElement>(".quota-row .quota-meter")];
const bar = (meter: HTMLElement) => meter.querySelector<HTMLElement>(".quota-bar i")!;
const pct = (meter: HTMLElement) => meter.querySelector<HTMLElement>(".quota-pct")!;

beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); });
afterEach(() => unmountReact());

test("a module drawn with its data stands still, and so does the same data drawn again", () => {
  draw(ready(row("codex", 46), row("claude", 39)));
  const first = meters();
  expect(first.map(meter => bar(meter).style.width)).toEqual(["46%", "39%"]);
  for (const meter of first) {
    expect(meter.classList.contains("is-arriving")).toBeFalse();
    expect(pct(meter).classList.contains("swap-in")).toBeFalse();
  }
  expect(document.querySelector(".quota-row.is-arriving")).toBeNull();
  const numbers = first.map(pct);
  draw(ready(row("codex", 46), row("claude", 39)));
  expectSameNodes(meters(), first);
  expectSameNodes(meters().map(pct), numbers);
  expect(document.querySelector(".is-arriving, .swap-in")).toBeNull();
});

test("rows that replace the loading rows arrive: they fade in and their bars grow one step apart", () => {
  draw(loading);
  expect(document.querySelectorAll(".is-skeleton")).toHaveLength(3);
  draw(ready(row("codex", 46), row("claude", 39), row("copilot", 82)));
  expect(document.querySelector(".is-skeleton")).toBeNull();
  expect(document.querySelectorAll(".quota-row.is-arriving")).toHaveLength(3);
  expect(meters().map(meter => [meter.classList.contains("is-arriving"), meter.style.getPropertyValue("--quota-i")]))
    .toEqual([[true, "0"], [true, "1"], [true, "2"]]);
  // The number was not there before: it arrives with its row and is not a swap.
  expect(document.querySelector(".swap-in")).toBeNull();
  // A repaint while they arrive keeps the same nodes, so nothing starts over.
  const nodes = meters();
  draw(ready(row("codex", 46), row("claude", 39), row("copilot", 82)));
  expectSameNodes(meters(), nodes);
});

test("the arrival mark is let go by the next render once the arrival has played", async () => {
  draw(loading);
  draw(ready(row("codex", 46)));
  const meter = meters()[0];
  expect(meter.classList.contains("is-arriving")).toBeTrue();
  await new Promise(resolve => setTimeout(resolve, 720));
  // Nothing redraws by itself to drop it: the class has no animation left to run.
  expect(meter.classList.contains("is-arriving")).toBeTrue();
  draw(ready(row("codex", 46)));
  expectSameNode(meters()[0], meter);
  expect(meter.classList.contains("is-arriving")).toBeFalse();
  expect(meter.style.getPropertyValue("--quota-i")).toBe("");
});

test("a refreshed share moves the bar that is there and swaps the number in; the row does not arrive again", () => {
  draw(ready(row("codex", 46), row("claude", 39)));
  const [codex, claude] = meters();
  const fill = bar(codex);
  const steady = pct(claude);
  draw(ready(row("codex", 41), row("claude", 39)));
  expectSameNode(meters()[0], codex);
  // Same element, new inline width: the stylesheet's transition carries it.
  expectSameNode(bar(codex), fill);
  expect(fill.style.width).toBe("41%");
  expect(codex.getAttribute("aria-valuenow")).toBe("41");
  expect(pct(codex).textContent).toBe("41%");
  expect(pct(codex).classList.contains("swap-in")).toBeTrue();
  expectSameNode(pct(claude), steady);
  expect(steady.classList.contains("swap-in")).toBeFalse();
  expect(document.querySelector(".is-arriving")).toBeNull();
});

test("the bar travels on its width, grows only when arriving, and keeps neither under reduced motion", () => {
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)![1];
  const base = css.replace(reduced, "");
  expect(base).toMatch(/\.quota-bar i\s*\{[^}]*transition:\s*width var\(--dur-3\) var\(--ease\)/);
  expect(base).toMatch(/\.quota-meter\.is-arriving \.quota-bar i\s*\{[^}]*animation:\s*quota-grow var\(--dur-4\) var\(--ease\) backwards;[^}]*animation-delay:\s*calc\(min\(var\(--quota-i, 0\), 6\) \* 40ms\)/);
  expect(base).toMatch(/\.quota-row\.is-arriving,\s*\.quota-card\.is-arriving\s*\{[^}]*animation:\s*fade-in var\(--dur-2\) var\(--ease\)/);
  expect(base).toMatch(/\.quota-refresh > svg\.is-turning\s*\{[^}]*animation:\s*quota-turn var\(--dur-4\) var\(--ease\)/);
  expect(reduced).toMatch(/\.quota-meter\.is-arriving \.quota-bar i,\s*\.quota-refresh > svg\.is-turning\s*\{[^}]*animation:\s*none/);
  // The fade of an arriving row is kept: it is not travel.
  expect(reduced).not.toMatch(/quota-row|quota-card/);
});

test("a level, a balance and a meter with nothing current are drawn without a bar or a percentage", () => {
  const kinds: QuotaModuleRow[] = [
    { ...row("claude", 0), meter: { kind: "level", pips: 1, word: "偏低", tone: "warn", aria: "level" } },
    { ...row("cursor", 0), meter: { kind: "balance", text: "$12.40", aria: "balance" } },
    { ...row("grok", 0), meter: { kind: "pending", text: "待刷新", aria: "pending" } },
  ];
  draw(ready(...kinds));
  const [level, balance, pending] = meters();
  expect(level.classList.contains("is-level") && level.classList.contains("is-warn")).toBeTrue();
  expect([...level.querySelectorAll(".quota-pips i")].map(pip => pip.classList.contains("is-on"))).toEqual([true, false, false, false, false]);
  expect(level.querySelector(".quota-word")!.textContent).toBe("偏低");
  expect(balance.querySelector(".quota-amount")!.textContent).toBe("$12.40");
  expect(pending.querySelector(".quota-word")!.textContent).toBe("待刷新");
  for (const meter of [level, balance, pending]) {
    expect(meter.getAttribute("role")).toBe("img");
    expect(meter.hasAttribute("aria-valuenow")).toBeFalse();
    expect(meter.querySelector(".quota-bar, .quota-pct")).toBeNull();
  }
  // A balance that changes is swapped in like a share's number.
  draw(ready(kinds[0], { ...kinds[1], meter: { kind: "balance", text: "$9.10", aria: "balance" } }, kinds[2]));
  expect(meters()[1].querySelector(".quota-amount")!.classList.contains("swap-in")).toBeTrue();
});

test("the way into the full page counts the accounts and, apart, the ones that need the reader", () => {
  draw({ ...ready(row("codex", 46)), total: 9, attention: 2 });
  const value = document.querySelector(".quota-all .set-val")!;
  expect(value.textContent).toBe("共 9 个 · 2 个需要处理");
  expect(value.querySelector(".quota-attention-count")!.textContent).toBe("2 个需要处理");
  draw({ ...ready(row("codex", 46)), total: 3, attention: 0 });
  expect(document.querySelector(".quota-all .set-val")!.textContent).toBe("共 3 个");
  draw({ ...ready(), total: 0, attention: 1 });
  expect(document.querySelector(".quota-all .set-val")!.textContent).toBe("1 个需要处理");
  draw({ ...ready(), total: 0, attention: 0 });
  expect(document.querySelector(".quota-all .set-val")).toBeNull();
});
