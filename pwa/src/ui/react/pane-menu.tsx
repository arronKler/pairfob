import { paneFillCopy, tabIsSplit } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import { TERM_MODE_OPTIONS } from "../../lib/terminal-mode";
import { TERM_MODE_LABEL, TERM_MODE_MENU } from "../../lib/ui-model";
import { closePane, copyScreenText, createSelectedTab, createSelectedWorktree, layoutSelectedPane,
  listSelectedWorktrees, openSelectedWorktree, renamePane, splitSelectedPane } from "../../live-operations";
import { render } from "../../paint";
import { TERM_COL_PRESETS, TERM_FONT_MAX, TERM_FONT_MIN, clampTermFont, paneTermMode, saveTermFont, selectedAgent, state } from "../../state";
import { canEnterAgentChat } from "../agent-chat";
import { openBoard } from "../board";
import { retryFullTerminal, setFullTerminalComposeLive, setTermFit } from "../full-terminal";
import { setComposeLive, toggleTermSelect, toggleTermWrap } from "../session-view";
import { selectPaneTermMode } from "../terminal-mode";
import { MenuItem, MenuRadio, MenuSection, showActionSheet, type ActionSheetController, type SheetAction } from "./action-sheet";

type Entry = { label: string; run: SheetAction; disabled?: boolean };
function ActionSection({ modal, title, entries }: { modal: ActionSheetController; title: string; entries: Entry[] }) {
  return entries.length ? <MenuSection title={title}>{entries.map(entry => <MenuItem key={entry.label} modal={modal}
    action={entry.run} disabled={entry.disabled}>{entry.label}</MenuItem>)}</MenuSection> : null;
}

export function fillSelectedPane(): void { void layoutSelectedPane("zoom"); }

export function openPaneMenu(): void {
  const selected = selectedAgent();
  const split = tabIsSplit(selected, state.agents);
  const fill = paneFillCopy(selected, state.agents);
  const currentMode = paneTermMode(state.paneId);
  const caps = state.operationCapabilities;
  const font = (delta: number) => () => {
    state.termFontPx = clampTermFont(state.termFontPx + delta);
    saveTermFont();
    render();
  };
  showActionSheet(t("pane.menuTitle"), modal => <>
    <h3 className="menu-section-title">{t("pane.sectionMode")}</h3>
    <div className="seg menu-mode" role="radiogroup" aria-label={t("mode.aria")}>
      {TERM_MODE_OPTIONS.map(mode => <MenuRadio key={mode} modal={modal} label={TERM_MODE_LABEL[mode]} aria={TERM_MODE_MENU[mode]}
        selected={currentMode === mode} disabled={mode === "agent" && currentMode !== mode && !canEnterAgentChat()}
        action={() => selectPaneTermMode(mode)} />)}
    </div>
    <p className="empty-sub">{t("mode.autoHint")}</p>
    {state.fullTerminal && <>
      <ActionSection modal={modal} title={t("pane.termSection")} entries={[{ label: t("pane.reconnect"), run: retryFullTerminal }]} />
      <h3 className="menu-section-title">{t("pane.width")}</h3>
      <div className="seg menu-mode" role="radiogroup" aria-label={t("pane.width")}>
        <MenuRadio modal={modal} label={t("pane.fit")} aria={t("pane.fitAria")} selected={state.termFit === "fit"} action={() => setTermFit("fit")} />
        {TERM_COL_PRESETS.map(cols => <MenuRadio key={cols} modal={modal} label={t("pane.colsShort", { cols })}
          aria={t("pane.panColsAria", { cols })} selected={state.termFit === "pan" && state.termCols === cols} action={() => setTermFit("pan", cols)} />)}
      </div>
    </>}
    {!caps.zoom_pane && split && <p className="empty-sub">{t("pane.splitUnsupported")}</p>}
    {!state.agentChat && <>
      <h3 className="menu-section-title">{t("menu.input")}</h3>
      <div className="seg menu-mode" role="radiogroup" aria-label={t("pane.inputAria")}>
        {[{ live: false, label: t("compose.batch"), aria: t("pane.composeAria") },
          { live: true, label: t("compose.live"), aria: t("pane.liveAria") }].map(option => <MenuRadio key={String(option.live)} modal={modal}
          label={option.label} aria={option.aria} selected={state.composeLive === option.live} action={() => {
            if (state.fullTerminal) setFullTerminalComposeLive(option.live);
            else void setComposeLive(option.live);
          }} />)}
      </div>
      <ActionSection modal={modal} title={t("menu.display")} entries={[
        ...(!state.fullTerminal ? [{ label: t(state.termWrap ? "pane.unwrap" : "menu.wrap"), run: toggleTermWrap }] : []),
        { label: t("menu.selectText"), run: () => toggleTermSelect(true) },
        { label: t("pane.fontUpCurrent", { n: state.termFontPx }), run: font(1), disabled: state.termFontPx >= TERM_FONT_MAX },
        { label: t("pane.fontDownCurrent", { n: state.termFontPx }), run: font(-1), disabled: state.termFontPx <= TERM_FONT_MIN },
        { label: t("menu.copyScreen"), run: copyScreenText },
      ]} />
    </>}
    <ActionSection modal={modal} title={t("menu.new")} entries={[
      ...(caps.create_tab ? [{ label: t("menu.newTab"), run: createSelectedTab }] : []),
      ...(caps.split_pane ? [{ label: t("menu.split"), run: splitSelectedPane }] : []),
    ]} />
    <ActionSection modal={modal} title={t("menu.worktree")} entries={[
      ...(caps.list_worktrees ? [{ label: t("menu.worktrees"), run: listSelectedWorktrees }] : []),
      ...(caps.create_worktree ? [{ label: t("menu.newWorktree"), run: createSelectedWorktree }] : []),
      ...(caps.open_worktree ? [{ label: t("menu.openWorktree"), run: openSelectedWorktree }] : []),
    ]} />
    <ActionSection modal={modal} title={t("menu.layout")} entries={[
      { label: t("menu.board"), run: () => openBoard(selected ? { workspaceId: selected.workspaceId, tabId: selected.tabId } : undefined) },
      ...(caps.zoom_pane && fill ? [{ label: fill.menu, run: fillSelectedPane }] : []),
      ...(caps.resize_pane ? [{ label: t("menu.zoom"), run: () => layoutSelectedPane("resize") }] : []),
      ...(caps.swap_pane && split ? [{ label: t("menu.swap"), run: () => layoutSelectedPane("swap") }] : []),
    ]} />
    <MenuItem modal={modal} action={renamePane}>{t("menu.renamePane")}</MenuItem>
    <MenuItem modal={modal} action={closePane} danger>{t("op.closePane")}</MenuItem>
    <MenuItem modal={modal}>{t("cancel")}</MenuItem>
  </>);
}
