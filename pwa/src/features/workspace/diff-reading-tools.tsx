import { ALargeSmall } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { t } from "../../lib/i18n";
import { showActionSheet } from "../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuStepper, MenuSwitch } from "../../shared/ui/overlay/menu-controls";
import { Button } from "../../shared/ui/primitives";
import { usePreferenceField } from "../settings/hooks";
import { autoDiffSize, canStepDiffSize, stepDiffSize } from "./diff-reading";
import { diffWrap, setDiffWrap, useDiffSize, useDiffWrap } from "./prefs";
import { isWrapKey, useKeyHint } from "./workspace-keys";

/** The pointer the style sheet sizes the lines for. */
const FINE = "(hover: hover) and (pointer: fine)";

/**
 * The style sheet's size for `lines`, read off them once they are drawn, and
 * again whenever what it follows changes: the terminal's size, or a mouse
 * coming or going on a tablet.
 */
function useAutoSize(lines: RefObject<HTMLElement | null>): number {
  const termFontPx = usePreferenceField((prefs) => prefs.termFontPx);
  const [auto, setAuto] = useState(() => autoDiffSize(null));
  useLayoutEffect(() => { setAuto(autoDiffSize(lines.current)); }, [lines, termFontPx]);
  useEffect(() => {
    const query = globalThis.matchMedia?.(FINE);
    const read = () => setAuto(autoDiffSize(lines.current));
    query?.addEventListener("change", read);
    return () => query?.removeEventListener("change", read);
  }, [lines]);
  return auto;
}

/** Size and wrap, applied in place: the reader watches the lines behind change. */
function DiffReadingSettings({ split, lines }: { split: boolean; lines: RefObject<HTMLElement | null> }) {
  const auto = useAutoSize(lines);
  const size = useDiffSize() ?? auto;
  const wraps = useDiffWrap();
  const wrapKey = useKeyHint("wrap");
  // The panel takes the keys while it is open; the one it names still turns the wrap.
  useEffect(() => {
    if (split) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isWrapKey(event)) return;
      event.preventDefault();
      setDiffWrap(!diffWrap());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [split]);
  return <MenuGroup>
    <MenuStepper label={t("pane.fontSize")} value={t("pane.fontPx", { n: Number(size.toFixed(1)) })}
      decrease={t("menu.fontDown")} increase={t("menu.fontUp")}
      onDecrease={() => stepDiffSize(-1, autoDiffSize(lines.current))} onIncrease={() => stepDiffSize(1, autoDiffSize(lines.current))}
      canDecrease={canStepDiffSize(-1, auto)} canIncrease={canStepDiffSize(1, auto)} />
    {!split && <MenuSwitch label={t("workspace.wrap")} title={wrapKey.title(t("workspace.wrap"))} keys={wrapKey.keys} checked={wraps} onChange={setDiffWrap} />}
  </MenuGroup>;
}

/**
 * How the open diff's `lines` read, behind one control so the info bar keeps
 * its room on a phone: the panel under it for a mouse, a sheet for a finger.
 * Lit, as a pressed tool is, while the lines are not as they come: kept whole,
 * or at a size the reader picked. Two fingers on the lines change the size too
 * (`useDiffPinch`), and Alt+Z the wrap (`workspace-keys`). Side by side there
 * is no wrap to turn, and the control is only the size.
 */
export function DiffReadingButton({ split, lines }: { split: boolean; lines: RefObject<HTMLElement | null> }) {
  const label = split ? t("pane.fontSize") : t("workspace.diffReading");
  const chosen = useDiffSize();
  const wraps = useDiffWrap();
  const set = chosen !== null || (!split && !wraps);
  // The light is said too, for a reader who cannot see it.
  return <Button className={`icon-btn workspace-tool workspace-diff-reading${set ? " is-set" : ""}`}
    aria-label={set ? t("workspace.diffReadingSet", { label }) : label} title={label} aria-haspopup="dialog"
    onClick={() => showActionSheet(label, () => <DiffReadingSettings split={split} lines={lines} />,
      { className: "diff-reading-sheet", popover: "panel" })}>
    <ALargeSmall size={16} aria-hidden="true" />
  </Button>;
}
