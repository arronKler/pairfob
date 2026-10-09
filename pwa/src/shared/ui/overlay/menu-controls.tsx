import { ChevronRight, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../primitives/button";
import type { ActionSheetController, SheetAction } from "./action-sheet";
import { useMenuItemRole } from "./popover-frame";

/**
 * Action-sheet controls by weight. Settings (`MenuSetting`, `MenuStepper`,
 * `MenuSwitch`) apply in place and leave the sheet open; tiles and rows either
 * close with an action or navigate within the sheet. The sheet's own close
 * button, backdrop and drag replace a trailing Cancel row.
 */

/** One card of related rows. */
export function MenuGroup({ label, children, className = "" }: { label?: string; children: ReactNode; className?: string }) {
  return <div className={`menu-group${className ? ` ${className}` : ""}`} role={label ? "group" : undefined} aria-label={label}>{children}</div>;
}

/** A labelled setting row; `stacked` puts a wide control under its label. */
export function MenuSetting({ label, hint, stacked = false, children }: {
  label: string; hint?: string; stacked?: boolean; children: ReactNode;
}) {
  return <div className={`menu-setting${stacked ? " is-stacked" : ""}`}>
    <div className="menu-setting-label">{label}{hint && <small>{hint}</small>}</div>
    {children}
  </div>;
}

export function MenuStepper({ label, value, decrease, increase, onDecrease, onIncrease, canDecrease = true, canIncrease = true }: {
  label: string; value: string; decrease: string; increase: string;
  onDecrease: () => void; onIncrease: () => void; canDecrease?: boolean; canIncrease?: boolean;
}) {
  return <MenuSetting label={label}>
    <div className="menu-stepper" role="group" aria-label={label}>
      <Button className="menu-stepper-btn" aria-label={decrease} disabled={!canDecrease} onClick={onDecrease}><Minus size={18} aria-hidden="true" /></Button>
      <output className="menu-stepper-value" aria-live="polite">{value}</output>
      <Button className="menu-stepper-btn" aria-label={increase} disabled={!canIncrease} onClick={onIncrease}><Plus size={18} aria-hidden="true" /></Button>
    </div>
  </MenuSetting>;
}

export function MenuSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return <MenuSetting label={label}>
    <Button className="menu-switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
  </MenuSetting>;
}

type Target = { modal: ActionSheetController; action: SheetAction } | { onClick: () => void };
const activate = (target: Target) => "action" in target ? target.modal.close(target.action) : target.onClick();

export function MenuTiles({ children }: { children: ReactNode }) {
  return <div className="menu-tiles">{children}</div>;
}

/** A frequent action: icon over a short label, the full name for assistive tech. */
export function MenuTile({ icon, label, aria, disabled = false, ...target }: Target & {
  icon: ReactNode; label: string; aria?: string; disabled?: boolean;
}) {
  return <Button className="menu-tile" aria-label={aria} disabled={disabled} onClick={() => activate(target)}>
    <span className="menu-tile-icon" aria-hidden="true">{icon}</span><span className="menu-tile-label">{label}</span>
  </Button>;
}

/** A list row; `next` marks a row that opens a page inside the sheet. */
export function MenuRow({ icon, label, detail, next = false, danger = false, disabled = false, ...target }: Target & {
  icon?: ReactNode; label: string; detail?: string; next?: boolean; danger?: boolean; disabled?: boolean;
}) {
  return <Button className={`menu-row${danger ? " menu-danger" : ""}`} role={useMenuItemRole()} disabled={disabled} onClick={() => activate(target)}>
    {icon && <span className="menu-row-icon" aria-hidden="true">{icon}</span>}
    <span className="menu-row-label">{label}{detail && <small>{detail}</small>}</span>
    {next && <ChevronRight className="menu-row-next" size={18} aria-hidden="true" />}
  </Button>;
}
