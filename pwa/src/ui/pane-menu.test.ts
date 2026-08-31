import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./pane-menu.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live-operations.ts", import.meta.url)).text();

describe("session view sheet", () => {
  test("this-view menu keeps pane rename and close, not parent-object admin", () => {
    expect(source).toContain('sheet(t("pane.menuTitle"))');
    expect(source).toContain('item(t("menu.newTab"), createSelectedTab)');
    expect(source).not.toContain('section(t("pane.thisCell")');
    expect(source).toContain('item(t("menu.renamePane"), renamePane)');
    expect(source).toContain('item(t("op.closePane"), closePane, "danger")');
    expect(source).not.toContain('item("改标签页名"');
    expect(source).not.toContain('item("改工作区名"');
    expect(source).not.toContain('item("关闭整个标签页"');
    expect(source).not.toContain('section("管理"');
    expect(liveSource).toContain('t("op.renamePane")');
    expect(liveSource).toContain('t("op.renameTab")');
    expect(liveSource).toContain('t("op.renameWorkspace")');
    expect(liveSource).not.toMatch(/新建标签(?!页)|关闭整个标签(?!页)|标签名不能为空/);
  });

  test("conversation transcripts open the agent-chat mode, not the history sheet", () => {
    expect(source).toContain("TERM_MODE_LABEL");
    expect(source).toContain("enterAgentChat");
    expect(source).toContain("canEnterAgentChat()");
    expect(source).not.toMatch(/\bopenSelectedHistory\b/);
    expect(source).not.toContain("对话记录");
  });

  test("earlier rendered output is a menu action, not an overlay on the live pane", () => {
    expect(source).toContain('item(t("menu.history"), openSelectedTerminalHistory)');
    expect(source).toContain("state.operationCapabilities.history");
    expect(liveSource).toContain("showHistory({ terminal: load })");
    expect(liveSource).not.toContain("if (!selected.historyAvailable) return");
  });

  test("pane modes switch from a tab bar; other actions stay a labeled list", () => {
    expect(source).toContain("menu-mode");
    expect(source).toContain("TERM_MODE_LABEL");
    expect(source).toContain("TERM_MODE_MENU.full");
    expect(source).toContain("enterFullTerminal");
    expect(source).toContain("enterAgentChat");
    expect(source).toContain("leaveToGuided");
    expect(source).toContain('item(t("pane.reconnect"), retryFullTerminal)');
    expect(source).toContain("fill.menu");
    expect(source).toContain("fillSelectedPane");
    expect(source).toContain('t("pane.splitUnsupported")');
    expect(source).toContain('t("pane.fontUpCurrent"');
    expect(source).toContain('t("pane.fontDownCurrent"');
    expect(source).toContain('item(t("menu.zoom"), () => layoutSelectedPane("resize"))');
    expect(source).toContain('section(t("menu.display")');
    expect(source).toContain('menu-section-title", t("pane.width")');
    expect(source).toContain('label: t("pane.fit")');
    expect(source).toContain('label: t("pane.cols80Short")');
    expect(source).toContain("setTermFit");
    expect(source).toContain("!state.fullTerminal ? [item(state.termWrap");
    expect(source).not.toContain("menu-grid");
    expect(source).not.toContain("menu-tile");
    expect(source).not.toContain("切换单窗放大");
    expect(source).not.toContain("放大字号");
    expect(source).not.toContain("完整终端");
  });

  test("compose live typing is a switch on this sheet", () => {
    expect(source).toContain('menu-section-title", t("menu.input")');
    expect(source).toContain("setComposeLive");
    expect(source).toContain('label: t("compose.batch")');
    expect(source).toContain('label: t("compose.live")');
    expect(source).toContain("!state.fullTerminal && !state.agentChat");
    expect(source).not.toContain("改为组字后发送");
    expect(source).not.toContain("改为实时输入");
  });

  test("prompting the agent is the 对话 view, not a menu dialog", () => {
    expect(source).not.toContain('section("Agent"');
    expect(source).not.toContain("给 Agent 发任务");
    expect(source).not.toContain("promptSelectedAgent");
    expect(source).not.toContain("canPromptAgent");
  });

  test("对话 hides terminal display actions that do not apply to the transcript", () => {
    expect(source).toContain("if (!state.agentChat)");
    const display = source.slice(source.indexOf("if (!state.agentChat)"), source.indexOf('section(t("menu.new")'));
    expect(display).toContain('section(t("menu.display")');
    expect(display).toContain("toggleTermWrap");
    expect(display).toContain("toggleTermSelect");
    expect(display).toContain("copyScreenText");
    expect(display).toContain('t("menu.history")');
  });

  test("view actions wait until the sheet has closed", () => {
    expect(source).toContain("afterClose(parts.dialog, option.run)");
    expect(source).toContain("sheetItem");
    expect(source).not.toMatch(/parts\.close\(\);\s*await action\(\)/);
  });
});
