import { useHardwareKeyboard } from "../../app/input-mode";
import { setComposeEnterSends, setDefaultComposeLive, setDefaultTermMode } from "../../features/settings/preferences-store";
import { t } from "../../lib/i18n";
import { TERM_MODE_OPTIONS, type TermMode } from "../../lib/terminal-mode";
import { TERM_MODE_LABEL } from "../../lib/ui-model";
import { SegmentedControl, SegmentedOption, SetGroup, SetItem, SetSwitch } from "../../shared/ui/primitives";

/**
 * Session defaults: three ordinary rows, chosen in place. Mode and input are
 * segmented controls on the row's trailing edge, Return-sends is a switch, and
 * the note under the card says what the current choices mean — so the rows
 * stay one line and nothing opens a sheet.
 *
 * Return-sends governs the on-screen keyboard only: a hardware keyboard always
 * sends with Enter. Where one is in use the row and its note say so, or the
 * switch would read "off" beside a field whose Enter sends.
 */

const MODE_DESC = {
  auto: "set.modeDesc.auto", guided: "set.modeDesc.guided", full: "set.modeDesc.full", agent: "set.modeDesc.agent",
} as const satisfies Record<TermMode, string>;

export function composeLabel(live: boolean): string {
  return live ? t("compose.live") : t("compose.batch");
}

export function SessionDefaults({ mode, live, enterSends }: { mode: TermMode; live: boolean; enterSends: boolean }) {
  const keyboard = useHardwareKeyboard();
  const note = t("set.defaultsNote", {
    mode: TERM_MODE_LABEL[mode], modeDesc: t(MODE_DESC[mode]),
    input: composeLabel(live), inputDesc: t(live ? "set.inputDesc.live" : "set.inputDesc.batch"),
    enter: keyboard ? t(enterSends ? "deskSet.enterOn" : "deskSet.enterOff") : t(enterSends ? "set.enterOn" : "set.enterOff"),
  });
  return <SetGroup className="session-defaults" label={t("settings.defaults")} note={note}>
    <SetItem label={t("settings.mode")} trailing={
      <SegmentedControl className="set-seg" aria-label={t("set.modeAria")}>
        {TERM_MODE_OPTIONS.map(id => <SegmentedOption key={id} selected={mode === id}
          onClick={() => { if (mode !== id) setDefaultTermMode(id); }}>{TERM_MODE_LABEL[id]}</SegmentedOption>)}
      </SegmentedControl>} />
    <SetItem label={t("settings.input")} trailing={
      <SegmentedControl className="set-seg" aria-label={t("set.inputAria")}>
        {[false, true].map(value => <SegmentedOption key={String(value)} selected={live === value}
          onClick={() => { if (live !== value) setDefaultComposeLive(value); }}>{composeLabel(value)}</SegmentedOption>)}
      </SegmentedControl>} />
    <SetItem label={t(keyboard ? "deskSet.enterKeySends" : "set.enterKeySends")} labelId="set-enter-sends"
      trailing={<SetSwitch checked={enterSends} labelledBy="set-enter-sends" onChange={setComposeEnterSends} />} />
  </SetGroup>;
}
