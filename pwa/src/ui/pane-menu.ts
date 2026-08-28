import { agentMeta, agentTitle, paneFillCopy, statusLabel, tabIsSplit } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { chevron } from "./chrome";
import { groupAgents } from "../lib/ranking";
import { TERM_MODE_LABEL, TERM_MODE_MENU } from "../lib/ui-model";
import {
  closePane,
  closeTab,
  copyScreenText,
  createSelectedTab,
  createSelectedWorktree,
  layoutSelectedPane,
  listSelectedWorktrees,
  openPane,
  openSelectedTerminalHistory,
  openSelectedWorktree,
  renamePane,
  renameTab,
  renameWorkspace,
  splitSelectedPane,
} from "../live";
import { render } from "../paint";
import { TERM_FONT_MAX, TERM_FONT_MIN, clampTermFont, saveTermFont, selectedAgent, state } from "../state";
import { canEnterAgentChat, enterAgentChat, leaveAgentChat } from "./agent-chat";
import { enterFullTerminal, leaveFullTerminal, retryFullTerminal, setTermFit } from "./full-terminal";
import { setComposeLive, toggleTermSelect, toggleTermWrap } from "./session-view";

type Sheet = { dialog: HTMLDialogElement; form: HTMLFormElement; body: HTMLElement; close: () => void };

let sheetSerial = 0;

/** Ignore backdrop taps that are still the gesture that opened the sheet. */
const OPEN_GESTURE_MS = 400;

function sheet(title: string): Sheet {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal sheet");
  const titleID = `sheet-title-${++sheetSerial}`;
  dialog.setAttribute("aria-labelledby", titleID);
  const form = node("form");
  form.method = "dialog";
  const heading = node("h2", "modal-title", title);
  heading.id = titleID;
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const dismiss = button("×", "icon-btn sheet-close", close);
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "关闭");
  const head = node("div", "sheet-head");
  head.append(heading, dismiss);
  const body = node("div", "sheet-body");
  form.append(head, body);
  dialog.append(form);
  const openedAt = performance.now();
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (performance.now() - openedAt < OPEN_GESTURE_MS) return;
    close();
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      trigger?.focus();
    },
    { once: true },
  );
  return { dialog, form, body, close };
}

/** WebKit drops showModal() that runs in the same turn as dialog.close(). */
function afterClose(dialog: HTMLDialogElement, action: () => void | Promise<void>): void {
  const run = () => {
    window.setTimeout(() => void action(), 0);
  };
  if (!dialog.open) {
    run();
    return;
  }
  dialog.addEventListener("close", run, { once: true });
  dialog.close();
}

function present(parts: Sheet): void {
  // A sheet left open swallows every tap on the page beneath it, so never stack
  // two. Reopening always replaces rather than layers.
  for (const stale of document.querySelectorAll("dialog.sheet")) stale.remove();
  document.body.append(parts.dialog);
  parts.dialog.showModal();
  (parts.form.querySelector("button:not(:disabled):not(.sheet-close)") as HTMLButtonElement | null)?.focus();
}

export function fillSelectedPane(): void {
  void layoutSelectedPane("zoom");
}

export function openPaneSwitcher(): void {
  const parts = sheet("切换会话");
  const list = node("div", "switch-list");
  for (const group of groupAgents(state.agents, state.listGroup, state.paneTouched)) {
    for (const agent of group.items) {
      const item = node("button", `switch-item${agent.paneId === state.paneId ? " on" : ""}`);
      item.type = "button";
      const main = node("span", "switch-main");
      const head = node("span", "switch-head");
      head.append(node("span", `agent-dot agent-${agent.status}`), node("span", "switch-name", agentTitle(agent, state.listGroup)));
      main.append(head);
      const status = statusLabel(agent.status);
      const meta = [status, agentMeta(agent, state.listGroup)].filter(Boolean).join(" · ");
      if (meta) main.append(node("span", "switch-meta", meta));
      item.append(main, chevron());
      item.addEventListener("click", () => {
        afterClose(parts.dialog, () => {
          if (agent.paneId !== state.paneId) void openPane(agent.paneId);
        });
      });
      list.append(item);
    }
  }
  if (!list.children.length) list.append(node("p", "empty-sub", "还没有读到别的会话。"));
  parts.body.append(list, button("取消", "menu-item", parts.close));
  present(parts);
}

export function openPaneMenu(): void {
  const parts = sheet("会话操作");
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "", disabled = false) => {
    const el = button(label, `menu-item${variant ? ` menu-${variant}` : ""}`, () => afterClose(parts.dialog, action));
    el.disabled = disabled;
    return el;
  };
  const section = (label: string, entries: HTMLButtonElement[]) => {
    if (entries.length) parts.body.append(node("h3", "menu-section-title", label), ...entries);
  };
  const leaveToGuided = () => {
    if (state.fullTerminal) void leaveFullTerminal();
    else if (state.agentChat) leaveAgentChat();
  };
  const currentMode = state.fullTerminal ? "full" : state.agentChat ? "agent" : "guided";
  const modeBar = node("div", "seg menu-mode");
  modeBar.setAttribute("role", "radiogroup");
  modeBar.setAttribute("aria-label", "会话模式");
  for (const option of [
    { id: "guided" as const, run: leaveToGuided },
    { id: "full" as const, run: enterFullTerminal, aria: TERM_MODE_MENU.full },
    { id: "agent" as const, run: enterAgentChat },
  ]) {
    const selected = currentMode === option.id;
    const choice = button(TERM_MODE_LABEL[option.id], `seg-item${selected ? " on" : ""}`);
    choice.setAttribute("role", "radio");
    choice.setAttribute("aria-checked", selected ? "true" : "false");
    if (option.aria) choice.setAttribute("aria-label", option.aria);
    choice.disabled = option.id === "agent" && !selected && !canEnterAgentChat();
    choice.addEventListener("click", () => {
      if (selected) return;
      afterClose(parts.dialog, option.run);
    });
    modeBar.append(choice);
  }
  parts.body.append(node("h3", "menu-section-title", "模式"), modeBar);

  const selected = selectedAgent();
  const split = tabIsSplit(selected, state.agents);
  const fill = paneFillCopy(selected, state.agents);
  if (state.fullTerminal) {
    section("终端", [item("重新连接终端", retryFullTerminal)]);
    const fitBar = node("div", "seg menu-mode");
    fitBar.setAttribute("role", "radiogroup");
    fitBar.setAttribute("aria-label", "终端宽度");
    for (const option of [
      { id: "fit" as const, label: "适应屏幕", aria: "按手机宽度缩小电脑上的终端" },
      { id: "pan" as const, label: "80 列", aria: "保持 80 列，可左右滑动" },
    ]) {
      const on = state.termFit === option.id;
      const choice = button(option.label, `seg-item${on ? " on" : ""}`);
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", on ? "true" : "false");
      choice.setAttribute("aria-label", option.aria);
      choice.addEventListener("click", () => {
        if (on) return;
        afterClose(parts.dialog, () => setTermFit(option.id));
      });
      fitBar.append(choice);
    }
    parts.body.append(node("h3", "menu-section-title", "宽度"), fitBar);
  }
  if (!state.operationCapabilities.zoom_pane && split) {
    parts.body.append(node("p", "empty-sub", "电脑上是分屏。当前 Herdr 还不支持铺满这一格。"));
  }
  if (!state.fullTerminal && !state.agentChat) {
    const inputBar = node("div", "seg menu-mode");
    inputBar.setAttribute("role", "radiogroup");
    inputBar.setAttribute("aria-label", "终端输入方式");
    for (const option of [
      { live: false, label: "组字", aria: "组字，写完再发送" },
      { live: true, label: "实时", aria: "实时，边打边进终端" },
    ]) {
      const on = state.composeLive === option.live;
      const choice = button(option.label, `seg-item${on ? " on" : ""}`);
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", on ? "true" : "false");
      choice.setAttribute("aria-label", option.aria);
      choice.addEventListener("click", () => {
        if (on) return;
        afterClose(parts.dialog, () => void setComposeLive(option.live));
      });
      inputBar.append(choice);
    }
    parts.body.append(node("h3", "menu-section-title", "输入"), inputBar);
  }
  section("显示", [
    ...(!state.fullTerminal ? [item(state.termWrap ? "关掉自动折行" : "长行自动折行", toggleTermWrap)] : []),
    item("选择文本", () => toggleTermSelect(true)),
    item(
      `文字加大（当前 ${state.termFontPx}px）`,
      () => {
        state.termFontPx = clampTermFont(state.termFontPx + 1);
        saveTermFont();
        render();
      },
      "",
      state.termFontPx >= TERM_FONT_MAX,
    ),
    item(
      `文字减小（当前 ${state.termFontPx}px）`,
      () => {
        state.termFontPx = clampTermFont(state.termFontPx - 1);
        saveTermFont();
        render();
      },
      "",
      state.termFontPx <= TERM_FONT_MIN,
    ),
    item("复制画面文本", copyScreenText),
    ...(state.operationCapabilities.history ? [item("更早的输出", openSelectedTerminalHistory)] : []),
  ]);
  section("新建", [
    ...(state.operationCapabilities.create_tab ? [item("新建标签页", createSelectedTab)] : []),
    ...(state.operationCapabilities.split_pane ? [item("分屏", splitSelectedPane)] : []),
  ]);
  section("Worktree", [
    ...(state.operationCapabilities.list_worktrees ? [item("Worktree 列表", listSelectedWorktrees)] : []),
    ...(state.operationCapabilities.create_worktree ? [item("新建 Worktree", createSelectedWorktree)] : []),
    ...(state.operationCapabilities.open_worktree ? [item("打开 Worktree", openSelectedWorktree)] : []),
  ]);
  section("布局", [
    ...(state.operationCapabilities.zoom_pane && fill ? [item(fill.menu, fillSelectedPane)] : []),
    ...(state.operationCapabilities.resize_pane ? [item("让这一格大一点", () => layoutSelectedPane("resize"))] : []),
    ...(state.operationCapabilities.swap_pane && split ? [item("和对面一格对调", () => layoutSelectedPane("swap"))] : []),
  ]);
  section("管理", [
    item("改会话名", renamePane),
    item("改标签页名", renameTab),
    item("改工作区名", renameWorkspace),
    item("关闭这个会话", closePane, "danger"),
    item("关闭整个标签页", closeTab, "danger"),
  ]);
  parts.body.append(item("取消", parts.close));
  present(parts);
}
