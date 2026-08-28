import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./pane-menu.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../live.ts", import.meta.url)).text();

describe("session action sheet", () => {
  test("title ids do not need a secure-context UUID", () => {
    expect(source).not.toContain("randomUUID");
    expect(source).toContain("sheet-title-");
  });

  /**
   * The ⋯ control sits above a bottom sheet. Opening from its click used to
   * attach a backdrop dismiss immediately, so the same tap landed on the
   * dialog and closed it before anything painted.
   */
  test("a full-height sheet can be dismissed from the header", () => {
    const sheet = source.slice(source.indexOf("function sheet("), source.indexOf("function afterClose("));
    expect(sheet).toContain("sheet-close");
    expect(sheet).toContain('aria-label", "关闭"');
    expect(sheet).toContain("sheet-head");
    expect(sheet).toContain("sheet-body");
    expect(sheet).toContain("form.append(head, body)");
    expect(source).toContain("button:not(:disabled):not(.sheet-close)");
    expect(source).toContain("parts.body.append");
    expect(source).not.toContain("parts.form.append(list");
    expect(source).not.toContain("parts.form.append(item");
  });

  test("backdrop dismiss ignores the opening gesture", () => {
    const sheet = source.slice(source.indexOf("function sheet("), source.indexOf("function afterClose("));
    expect(sheet).toContain("OPEN_GESTURE_MS");
    expect(sheet).toContain("performance.now()");
    expect(sheet).not.toMatch(/preventDefault\(\);\s*close\(\)/);
  });

  /**
   * WebKit drops a showModal() that runs in the same turn as dialog.close().
   * Menu items that open a follow-up dialog would then look like a dead tap.
   */
  test("menu actions run only after the sheet has closed", () => {
    expect(source).toContain("function afterClose(");
    expect(source).toContain("window.setTimeout(() => void action(), 0)");
    expect(source).not.toMatch(/parts\.close\(\);\s*await action\(\)/);
    expect(source).toContain("afterClose(parts.dialog, action)");
  });

  test("rename actions identify the Herdr hierarchy in user-facing copy", () => {
    expect(source).toContain('item("新建标签页", createSelectedTab)');
    expect(source).toContain('item("改会话名", renamePane)');
    expect(source).toContain('item("改标签页名", renameTab)');
    expect(source).toContain('item("改工作区名", renameWorkspace)');
    expect(source).toContain('item("关闭整个标签页", closeTab');
    expect(liveSource).toContain('"修改会话名（留空恢复自动名称）"');
    expect(liveSource).toContain('askText("修改标签页名"');
    expect(liveSource).toContain('askText("修改工作区名"');
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
    expect(source).toContain('item("更早的输出", openSelectedTerminalHistory)');
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
    expect(source).toContain('item("重新连接终端", retryFullTerminal)');
    expect(source).toContain("fill.menu");
    expect(source).toContain("fillSelectedPane");
    expect(source).toContain("当前 Herdr 还不支持铺满这一格");
    expect(source).toContain("文字加大");
    expect(source).toContain("文字减小");
    expect(source).toContain("让这一格大一点");
    expect(source).toContain('section("显示"');
    expect(source).toContain('menu-section-title", "宽度"');
    expect(source).toContain('label: "适应屏幕"');
    expect(source).toContain('label: "80 列"');
    expect(source).toContain("setTermFit");
    expect(source).toContain("!state.fullTerminal ? [item(state.termWrap");
    expect(source).not.toContain("menu-grid");
    expect(source).not.toContain("menu-tile");
    expect(source).not.toContain("切换单窗放大");
    expect(source).not.toContain("放大字号");
    expect(source).not.toContain("完整终端");
  });

  test("compose live typing is a switch on this sheet", () => {
    expect(source).toContain('menu-section-title", "输入"');
    expect(source).toContain("setComposeLive");
    expect(source).toContain('label: "组字"');
    expect(source).toContain('label: "实时"');
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
});
