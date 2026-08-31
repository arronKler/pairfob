import { agentMeta, agentTitle, paneFillCopy, statusLabel, tabIsSplit } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { chevron } from "./chrome";
import { groupAgents } from "../lib/ranking";
import { TERM_MODE_LABEL, TERM_MODE_MENU } from "../lib/ui-model";
import {
  closePane,
  copyScreenText,
  createSelectedTab,
  createSelectedWorktree,
  layoutSelectedPane,
  listSelectedWorktrees,
  openSelectedTerminalHistory,
  openSelectedWorktree,
  renamePane,
  splitSelectedPane,
} from "../live-operations";
import { openPane } from "../live";
import { render } from "../paint";
import { TERM_FONT_MAX, TERM_FONT_MIN, clampTermFont, saveTermFont, selectedAgent, state } from "../state";
import { canEnterAgentChat, enterAgentChat, leaveAgentChat } from "./agent-chat";
import { enterFullTerminal, leaveFullTerminal, retryFullTerminal, setTermFit } from "./full-terminal";
import { setComposeLive, toggleTermSelect, toggleTermWrap } from "./session-view";
import { afterClose, present, sheet, sheetItem, sheetSection } from "./sheet";

export function fillSelectedPane(): void {
  void layoutSelectedPane("zoom");
}

export function openPaneSwitcher(): void {
  const parts = sheet(t("home.switcherTitle"));
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
  if (!list.children.length) list.append(node("p", "empty-sub", t("home.switcherEmpty")));
  parts.body.append(list, button(t("cancel"), "menu-item", parts.close));
  present(parts);
}

export function openPaneMenu(): void {
  const parts = sheet(t("pane.menuTitle"));
  const item = (label: string, action: () => void | Promise<void>, variant: "" | "danger" = "", disabled = false) =>
    sheetItem(parts, label, action, variant, disabled);
  const section = (label: string, entries: HTMLButtonElement[]) => sheetSection(parts, label, entries);
  const leaveToGuided = () => {
    if (state.fullTerminal) void leaveFullTerminal();
    else if (state.agentChat) leaveAgentChat();
  };
  const currentMode = state.fullTerminal ? "full" : state.agentChat ? "agent" : "guided";
  const modeBar = node("div", "seg menu-mode");
  modeBar.setAttribute("role", "radiogroup");
  modeBar.setAttribute("aria-label", t("mode.aria"));
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
  parts.body.append(node("h3", "menu-section-title", t("pane.sectionMode")), modeBar);

  const selected = selectedAgent();
  const split = tabIsSplit(selected, state.agents);
  const fill = paneFillCopy(selected, state.agents);
  if (state.fullTerminal) {
    section(t("pane.termSection"), [item(t("pane.reconnect"), retryFullTerminal)]);
    const fitBar = node("div", "seg menu-mode");
    fitBar.setAttribute("role", "radiogroup");
    fitBar.setAttribute("aria-label", t("pane.width"));
    for (const option of [
      { id: "fit" as const, label: t("pane.fit"), aria: t("pane.fitAria") },
      { id: "pan" as const, label: t("pane.cols80Short"), aria: t("pane.panAria") },
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
    parts.body.append(node("h3", "menu-section-title", t("pane.width")), fitBar);
  }
  if (!state.operationCapabilities.zoom_pane && split) {
    parts.body.append(node("p", "empty-sub", t("pane.splitUnsupported")));
  }
  if (!state.fullTerminal && !state.agentChat) {
    const inputBar = node("div", "seg menu-mode");
    inputBar.setAttribute("role", "radiogroup");
    inputBar.setAttribute("aria-label", t("pane.inputAria"));
    for (const option of [
      { live: false, label: t("compose.batch"), aria: t("pane.composeAria") },
      { live: true, label: t("compose.live"), aria: t("pane.liveAria") },
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
    parts.body.append(node("h3", "menu-section-title", t("menu.input")), inputBar);
  }
  if (!state.agentChat) {
    section(t("menu.display"), [
      ...(!state.fullTerminal ? [item(state.termWrap ? t("pane.unwrap") : t("menu.wrap"), toggleTermWrap)] : []),
      item(t("menu.selectText"), () => toggleTermSelect(true)),
      item(
        t("pane.fontUpCurrent", { n: state.termFontPx }),
        () => {
          state.termFontPx = clampTermFont(state.termFontPx + 1);
          saveTermFont();
          render();
        },
        "",
        state.termFontPx >= TERM_FONT_MAX,
      ),
      item(
        t("pane.fontDownCurrent", { n: state.termFontPx }),
        () => {
          state.termFontPx = clampTermFont(state.termFontPx - 1);
          saveTermFont();
          render();
        },
        "",
        state.termFontPx <= TERM_FONT_MIN,
      ),
      item(t("menu.copyScreen"), copyScreenText),
      ...(state.operationCapabilities.history ? [item(t("menu.history"), openSelectedTerminalHistory)] : []),
    ]);
  }
  section(t("menu.new"), [
    ...(state.operationCapabilities.create_tab ? [item(t("menu.newTab"), createSelectedTab)] : []),
    ...(state.operationCapabilities.split_pane ? [item(t("menu.split"), splitSelectedPane)] : []),
  ]);
  section(t("menu.worktree"), [
    ...(state.operationCapabilities.list_worktrees ? [item(t("menu.worktrees"), listSelectedWorktrees)] : []),
    ...(state.operationCapabilities.create_worktree ? [item(t("menu.newWorktree"), createSelectedWorktree)] : []),
    ...(state.operationCapabilities.open_worktree ? [item(t("menu.openWorktree"), openSelectedWorktree)] : []),
  ]);
  section(t("menu.layout"), [
    ...(state.operationCapabilities.zoom_pane && fill ? [item(fill.menu, fillSelectedPane)] : []),
    ...(state.operationCapabilities.resize_pane ? [item(t("menu.zoom"), () => layoutSelectedPane("resize"))] : []),
    ...(state.operationCapabilities.swap_pane && split ? [item(t("menu.swap"), () => layoutSelectedPane("swap"))] : []),
  ]);
  section(t("pane.thisCell"), [item(t("menu.renamePane"), renamePane), item(t("op.closePane"), closePane, "danger")]);
  parts.body.append(item(t("cancel"), parts.close));
  present(parts);
}
