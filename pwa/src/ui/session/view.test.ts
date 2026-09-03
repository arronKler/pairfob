import { describe, expect, test } from "bun:test";

const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const actionsSource = await Bun.file(new URL("./chrome-actions.ts", import.meta.url)).text();

describe("pane header keeps status surfaces in step", () => {
  /**
   * A working/idle flip seen while the pane is open runs patchChromeTitle, not a
   * full render, on a phone viewport. When the patch only rewrote the visible
   * text, the accessible name kept announcing the old status and the interrupt
   * button stayed mounted for an idle agent.
   */
  test("the patch path goes through the same status sync as the builder", () => {
    const calls = viewSource.match(/syncChromeStatus\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const patch = viewSource.slice(viewSource.indexOf("export function patchChromeTitle"));
    expect(patch).toContain("syncChromeStatus(chrome, wrap, selected)");
  });

  test("status sync owns the accessible name and the interrupt button", () => {
    const start = viewSource.indexOf("function syncChromeStatus(");
    const sync = viewSource.slice(start, viewSource.indexOf("function chromeNode("));
    expect(sync).toContain('"aria-label"');
    expect(sync).toContain("syncChromeStop(chrome, canInterruptAgent(selected.status)");
    expect(sync).not.toContain("title.after");
    expect(actionsSource).toContain(".icon-stop");
    expect(actionsSource).toContain('t("pane.interrupt")');
    expect(actionsSource).toContain('t("pane.menuTitle")');
  });

  test("nothing else builds the interrupt button behind the sync's back", () => {
    const outside = viewSource.split("function chromeNode(")[1] ?? "";
    expect(outside).not.toContain("icon-stop");
  });

  test("pane modes live in the more menu, not as extra chrome slots", () => {
    const chrome = viewSource.slice(viewSource.indexOf("function chromeNode("), viewSource.indexOf("function fillExtras("));
    expect(chrome).toContain("chromeActionCluster(handlers.onWorkspace, handlers.onMenu)");
    expect(chrome).not.toContain("mode-switch");
    expect(chrome).not.toContain("完整终端");
    expect(chrome).not.toContain("进入对话");
    expect(chrome).not.toContain("更多操作");
    expect(viewSource).not.toContain("full-terminal-retry");
    expect(viewSource).not.toContain("退出完整终端");
  });

  test("workspace inspection is a first-class trailing action before more", () => {
    expect(actionsSource).not.toContain("labEnabled");
    expect(actionsSource).toContain('button("", "icon-btn icon-workspace", onWorkspace)');
    expect(actionsSource).toContain('workspace.setAttribute("aria-label", t("workspace.open"))');
    expect(actionsSource.indexOf("actions.append(workspace)")).toBeGreaterThan(-1);
    expect(actionsSource.indexOf("actions.append(workspace)")).toBeLessThan(actionsSource.indexOf("actions.append(menu)"));
  });

  test("in-place pane reads keep the terminal Enter control in sync", () => {
    expect(viewSource).toContain("syncSendButton()");
    expect(viewSource).not.toContain("promptPanel");
  });

  test("app notices sit under the chrome, not in the dock or select bar", () => {
    const fill = viewSource.slice(viewSource.indexOf("export function fillSession"), viewSource.indexOf("export function finishSessionPaint"));
    expect(fill.indexOf("appendNotice(container)")).toBeGreaterThan(fill.indexOf("chromeNode("));
    expect(fill.indexOf("termView(")).toBeGreaterThan(fill.indexOf("appendNotice(container)"));
    const select = viewSource.slice(viewSource.indexOf("function selectBar("), viewSource.indexOf("export function fillSession"));
    expect(select).not.toContain("noteNode");
    expect(select).not.toContain("appendNotice");
  });

  test("the status dot sits with the status line so the title can use the full width", () => {
    const body = viewSource.slice(viewSource.indexOf("function titleBody("), viewSource.indexOf("function syncChromeStatus("));
    expect(body).toContain("chrome-name");
    expect(body).toContain("chrome-meta-text");
    expect(body).toContain("agent-dot");
    expect(body).not.toContain("chrome-name-row");
    const nameStart = body.indexOf('node("span", "chrome-name"');
    const metaStart = body.indexOf("chrome-meta");
    const dotStart = body.indexOf("agent-dot");
    expect(nameStart).toBeGreaterThan(-1);
    expect(metaStart).toBeGreaterThan(nameStart);
    expect(dotStart).toBeGreaterThan(metaStart);
  });

  test("the visible subtitle is a short status line, not the dashboard card meta", () => {
    const body = viewSource.slice(viewSource.indexOf("function chromeMeta("), viewSource.indexOf("function titleBody("));
    expect(body).toContain("cwdName(selected.cwd)");
    expect(body).toContain('tabIsSplit(selected, state.agents) ? t("chrome.split")');
    expect(body).not.toContain("agentMeta");
    expect(viewSource).toContain("function statusLine(");
    expect(viewSource).toContain("agentMeta(selected)");
    expect(viewSource).toContain("chromeName(selected)");
  });
});
