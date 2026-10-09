import { commitView } from "../../../app/host";
import { t } from "../../../lib/i18n";
import { TERM_MODE_OPTIONS, type TermMode } from "../../../lib/terminal-mode";
import { TERM_MODE_LABEL, TERM_MODE_MENU } from "../../../lib/ui-model";
import { usePreferences } from "../../settings/hooks";
import { TERM_COL_PRESETS, TERM_FONT_MAX, TERM_FONT_MIN, setTermFont, termFontPx } from "../../settings/preferences-store";
import { useCompose } from "../hooks";
import { canEnterAgentChat } from "../chat/agent-chat-controller";
import { setFullTerminalComposeLive, setTermFit } from "../full-terminal/full-terminal";
import { resolvedPaneTermMode, selectPaneTermMode } from "../term-mode";
import { setComposeLive } from "./compose";
import { toggleTermWrap } from "./term";
import { SegmentedControl } from "../../../shared/ui/primitives";
import { MenuRadio, type ActionSheetController } from "../../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuSetting, MenuStepper, MenuSwitch } from "../../../shared/ui/overlay/menu-controls";

/**
 * The pane sheet's mode choice. Mode changes the whole screen, so choosing one
 * closes the sheet. The line under it says what Auto picked right now, and why
 * a mode that cannot be chosen is off.
 *
 * It is the panel's first control proper, and where a mouse or the keyboard
 * starts in it: the identity above only names the session, and a ring on its
 * small path line would crowd the name and the status around it.
 */
export function PaneModeSetting({ modal, mode }: { modal: ActionSheetController; mode: TermMode }) {
  const agentOff = mode !== "agent" && !canEnterAgentChat();
  const hint = mode === "auto" ? t("pm.modeAuto", { mode: TERM_MODE_LABEL[resolvedPaneTermMode("auto")] })
    : t("pm.modeFixed", { mode: TERM_MODE_LABEL[mode] });
  return <div className="pane-mode">
    <SegmentedControl className="menu-mode" activation="manual" aria-label={t("mode.aria")}>
      {TERM_MODE_OPTIONS.map(option => <MenuRadio key={option} modal={modal} label={TERM_MODE_LABEL[option]} aria={TERM_MODE_MENU[option]}
        selected={mode === option} disabled={option === "agent" && agentOff} start
        action={() => selectPaneTermMode(option)} />)}
    </SegmentedControl>
    <p className="pane-mode-hint">{hint}{agentOff ? ` ${t("pm.modeAgentOff")}` : ""}</p>
  </div>;
}

/**
 * Input and display. Everything here applies in place and the reader sees it
 * take effect in the pane behind the sheet.
 */
export function PaneDisplaySettings({ modal, full, chat }: { modal: ActionSheetController; full: boolean; chat: boolean }) {
  const prefs = usePreferences();
  const { composeLive } = useCompose();
  const font = (delta: number) => { setTermFont(termFontPx() + delta); commitView(); };
  if (chat) return null;
  return <MenuGroup className="pane-quick" label={t("pm.groupDisplay")}>
    <MenuSetting label={t("menu.input")} hint={t(composeLive ? "pane.liveAria" : "pane.composeAria")}>
      <SegmentedControl className="menu-mode menu-seg-compact" activation="manual" aria-label={t("pane.inputAria")}>
        {[{ live: false, label: t("compose.batch"), aria: t("pane.composeAria") },
          { live: true, label: t("compose.live"), aria: t("pane.liveAria") }].map(option => <MenuRadio key={String(option.live)} modal={modal} stay
          label={option.label} aria={option.aria} selected={composeLive === option.live} action={async () => {
            if (full) setFullTerminalComposeLive(option.live);
            else await setComposeLive(option.live);
            commitView();
          }} />)}
      </SegmentedControl>
    </MenuSetting>
    <MenuStepper label={t("pane.fontSize")} value={t("pane.fontPx", { n: prefs.termFontPx })}
      decrease={t("menu.fontDown")} increase={t("menu.fontUp")} onDecrease={() => font(-1)} onIncrease={() => font(1)}
      canDecrease={prefs.termFontPx > TERM_FONT_MIN} canIncrease={prefs.termFontPx < TERM_FONT_MAX} />
    {!full && <MenuSwitch label={t("menu.wrap")} checked={prefs.termWrap} onChange={toggleTermWrap} />}
    {full && <MenuSetting label={t("pane.width")} stacked>
      <SegmentedControl className="menu-mode pane-width-options" activation="manual" aria-label={t("pane.width")}>
        <MenuRadio modal={modal} stay label={t("pane.fit")} aria={t("pane.fitAria")} selected={prefs.termFit === "fit"}
          action={() => { setTermFit("fit"); commitView(); }} />
        {TERM_COL_PRESETS.map(cols => <MenuRadio key={cols} modal={modal} stay label={t("pane.colsShort", { cols })}
          aria={t("pane.panColsAria", { cols })} selected={prefs.termFit === "pan" && prefs.termCols === cols}
          action={() => { setTermFit("pan", cols); commitView(); }} />)}
      </SegmentedControl>
    </MenuSetting>}
  </MenuGroup>;
}
