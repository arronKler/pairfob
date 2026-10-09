import { Check } from "lucide-react";
import type { ReactNode } from "react";
import type { ActionSheetController, SheetAction } from "./action-sheet";
import { useMenuItemRole } from "./popover-frame";

/**
 * A sheet row that names one choice: leading mark, title, optional detail line
 * and a check when it is the current one. Picking closes the sheet and runs the
 * action afterwards, like `MenuItem`.
 */
export function MenuChoice({ modal, icon, title, detail, selected = false, action, danger = false, disabled = false }: {
  modal: ActionSheetController;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  selected?: boolean;
  action?: SheetAction;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role={useMenuItemRole()}
      className={`menu-item menu-choice${danger ? " menu-danger" : ""}${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
      onClick={() => action ? modal.close(action) : modal.dismiss()}
    >
      {icon ? <span className="menu-choice-icon">{icon}</span> : null}
      <span className="menu-choice-text">
        <span className="menu-choice-title">{title}</span>
        {detail ? <span className="menu-choice-detail">{detail}</span> : null}
      </span>
      {selected ? <Check className="menu-choice-check" size={18} aria-hidden="true" /> : null}
    </button>
  );
}
