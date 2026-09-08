import { t } from "../../lib/i18n";
import { MenuItem, showActionSheet, type SheetAction } from "./action-sheet";

export function openFileMenu(name: string, rename?: SheetAction, remove?: SheetAction): void {
  showActionSheet(name, modal => <>
    {rename && <MenuItem modal={modal} action={rename}>{t("fileActions.rename")}</MenuItem>}
    {remove && <MenuItem modal={modal} action={remove} danger>{t("fileActions.delete")}</MenuItem>}
    <MenuItem modal={modal}>{t("cancel")}</MenuItem>
  </>);
}
