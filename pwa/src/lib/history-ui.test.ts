import { describe, expect, test } from "bun:test";

const historySource = await Bun.file(new URL("./history-ui.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live-operations.ts", import.meta.url)).text();
const chromeSource = await Bun.file(new URL("../ui/session/view.ts", import.meta.url)).text();
const termSource = await Bun.file(new URL("../ui/session/term.ts", import.meta.url)).text();
const menuSource = await Bun.file(new URL("../ui/pane-menu.ts", import.meta.url)).text();
const baseStyle = await Bun.file(new URL("../styles/base.css", import.meta.url)).text();
const settingsStyle = await Bun.file(new URL("../styles/settings.css", import.meta.url)).text();

describe("mobile history surface", () => {
  test("uses the frozen History RPC with a bounded terminal cursor", () => {
    expect(historySource).toContain('TERMINAL_HISTORY_CURSOR = "term:v1:200"');
    expect(liveSource).toContain("session.history(selected.paneId, cursor, 50)");
    expect(liveSource).toContain("showHistory({ terminal: load })");
    expect(liveSource).not.toMatch(/source\s*[:=]/);
    expect(liveSource).not.toContain("recent_unwrapped");
  });

  test("replaces overlapping terminal windows but appends transcript pages", () => {
    expect(historySource).toContain('state.text = page.items.map((item) => item.text).join("\\n")');
    expect(historySource).toContain("state.items = append ? [...state.items, ...page.items] : page.items");
    expect(historySource).toContain('t("hist.loadEarlier")');
    expect(historySource).toContain('messageOf(error, "read")');
  });

  test("rendered dump is a history sheet; conversation is a pane mode", () => {
    expect(chromeSource).not.toContain('button("历史"');
    expect(chromeSource).not.toContain("onHistory");
    expect(chromeSource).not.toContain("mode-switch");
    expect(menuSource).toContain("enterAgentChat");
    expect(menuSource).not.toContain("对话记录");
    expect(menuSource).toContain('item(t("menu.history"), openSelectedTerminalHistory)');
    expect(termSource).not.toContain("↑ 更早的输出");
    expect(termSource).not.toContain("olderThanLive");
    expect(historySource).toContain('return t("hist.earlier")');
    expect(historySource).toContain('t("hist.terminalBusy")');
    expect(historySource).toContain('setAttribute("role", "tablist")');
  });

  test("keeps touch targets and hidden pagination correct under author CSS", () => {
    expect(baseStyle).toContain("[hidden] { display: none !important; }");
    expect(settingsStyle).toMatch(/\.history-tab\s*\{[^}]*min-height:\s*44px/s);
    expect(historySource).toContain('viewport.setAttribute("aria-busy", String(state.loading))');
    expect(historySource).toContain("if (!hasContent) viewport.replaceChildren()");
  });
});
