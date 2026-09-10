import { boardLayouts } from "../../board/layout-store";
import { composeLive } from "../compose-store";
import { operationCapabilities } from "../../operations/capabilities-store";
import { liveAgents, selectedAgent } from "../../dashboard/catalog-store";
import { isAgentChat, isFullTerminal, openPaneId } from "../session-store";
import {
  TERM_COL_PRESETS,
  TERM_FONT_MAX,
  TERM_FONT_MIN,
  paneTermMode,
  setTermFont,
  termCols,
  termFit,
  termFontPx,
  termWrap,
} from "../../settings/preferences-store";
import { paneFillCopy, tabIsSplit } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import { TERM_MODE_OPTIONS } from "../../../lib/terminal-mode";
import { TERM_MODE_LABEL, TERM_MODE_MENU } from "../../../lib/ui-model";
import { closePane, copyScreenText, createSelectedTab, createSelectedWorktree, layoutSelectedPane,
  listSelectedWorktrees, openSelectedWorktree, renamePane, splitSelectedPane } from "../../../features/operations/controller";
import { canEnterAgentChat } from "../chat/agent-chat-controller";
import { commitView } from "../../../app/host";
import { openBoard } from "../../../pages/board/board-bridge";
import { retryFullTerminal, setFullTerminalComposeLive, setTermFit } from "../full-terminal/full-terminal";
import { setComposeLive } from "./compose";
import { toggleTermSelect, toggleTermWrap } from "./term";
import { selectPaneTermMode } from "../term-mode";
import { MenuItem, MenuRadio, MenuSection, showActionSheet, type ActionSheetController, type SheetAction } from "../../../shared/ui/overlay/action-sheet";

type Entry = { label: string; run: SheetAction; disabled?: boolean };
function ActionSection({ modal, title, entries }: { modal: ActionSheetController; title: string; entries: Entry[] }) {
  return entries.length ? <MenuSection title={title}>{entries.map(entry => <MenuItem key={entry.label} modal={modal}
    action={entry.run} disabled={entry.disabled}>{entry.label}</MenuItem>)}</MenuSection> : null;
}

export function fillSelectedPane(): void { void layoutSelectedPane("zoom"); }

export function openPaneMenu(): void {
  const selected = selectedAgent();
  const agents = [...liveAgents()];
  const split = tabIsSplit(selected, agents);
  const fill = paneFillCopy(selected, agents, boardLayouts());
  const currentMode = paneTermMode(openPaneId());
  const caps = operationCapabilities();
  const fontPx = termFontPx();
  const font = (delta: number) => () => {
    setTermFont(termFontPx() + delta);
    commitView();
  };
  showActionSheet(t("pane.menuTitle"), modal => <>
    <h3 className="menu-section-title">{t("pane.sectionMode")}</h3>
    <div className="seg menu-mode" role="radiogroup" aria-label={t("mode.aria")}>
      {TERM_MODE_OPTIONS.map(mode => <MenuRadio key={mode} modal={modal} label={TERM_MODE_LABEL[mode]} aria={TERM_MODE_MENU[mode]}
        selected={currentMode === mode} disabled={mode === "agent" && currentMode !== mode && !canEnterAgentChat()}
        action={() => selectPaneTermMode(mode)} />)}
    </div>
    <p className="empty-sub">{t("mode.autoHint")}</p>
    {isFullTerminal() && <>
      <ActionSection modal={modal} title={t("pane.termSection")} entries={[{ label: t("pane.reconnect"), run: retryFullTerminal }]} />
      <h3 className="menu-section-title">{t("pane.width")}</h3>
      <div className="seg menu-mode" role="radiogroup" aria-label={t("pane.width")}>
        <MenuRadio modal={modal} label={t("pane.fit")} aria={t("pane.fitAria")} selected={termFit() === "fit"} action={() => setTermFit("fit")} />
        {TERM_COL_PRESETS.map(cols => <MenuRadio key={cols} modal={modal} label={t("pane.colsShort", { cols })}
          aria={t("pane.panColsAria", { cols })} selected={termFit() === "pan" && termCols() === cols} action={() => setTermFit("pan", cols)} />)}
      </div>
    </>}
    {!caps.zoom_pane && split && <p className="empty-sub">{t("pane.splitUnsupported")}</p>}
    {!isAgentChat() && <>
      <h3 className="menu-section-title">{t("menu.input")}</h3>
      <div className="seg menu-mode" role="radiogroup" aria-label={t("pane.inputAria")}>
        {[{ live: false, label: t("compose.batch"), aria: t("pane.composeAria") },
          { live: true, label: t("compose.live"), aria: t("pane.liveAria") }].map(option => <MenuRadio key={String(option.live)} modal={modal}
          label={option.label} aria={option.aria} selected={composeLive() === option.live} action={() => {
            if (isFullTerminal()) setFullTerminalComposeLive(option.live);
            else void setComposeLive(option.live);
          }} />)}
      </div>
      <ActionSection modal={modal} title={t("menu.display")} entries={[
        ...(!isFullTerminal() ? [{ label: t(termWrap() ? "pane.unwrap" : "menu.wrap"), run: toggleTermWrap }] : []),
        { label: t("menu.selectText"), run: () => toggleTermSelect(true) },
        { label: t("pane.fontUpCurrent", { n: fontPx }), run: font(1), disabled: fontPx >= TERM_FONT_MAX },
        { label: t("pane.fontDownCurrent", { n: fontPx }), run: font(-1), disabled: fontPx <= TERM_FONT_MIN },
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
