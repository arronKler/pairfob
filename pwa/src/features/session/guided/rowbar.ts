import { paneRow, setPaneRow } from "../session-store";
import { showError, showStatus } from "../../../app/notices-store";
import { commitView } from "../../../app/host";
import { haptic } from "../../../lib/dom";
import { t } from "../../../lib/i18n";
import { rowPath, rowText } from "../../../lib/termrow";
import { insertCompose } from "./compose";
import { paneModel, type PaneModel } from "./pane-model";

export function rowBarContent(model: PaneModel): { text: string; path: string | null } | null {
  const index = paneRow();
  if (index === null) return null;
  const raw = model.texts[index];
  if (raw === undefined) return null;
  const text = rowText(raw);
  if (!text) return null;
  return { text, path: rowPath(raw) };
}

/** Drop a selected row that no longer has copyable text. Never call this from React render. */
export function discardEmptyPaneRow(model: PaneModel): boolean {
  if (paneRow() === null || rowBarContent(model)) return false;
  setPaneRow(null);
  return true;
}

export function openRow(index: number): void {
  const model = paneModel();
  const raw = model.texts[index];
  const text = raw === undefined ? "" : rowText(raw);
  if (!text) {
    if (paneRow() !== null) {
      setPaneRow(null);
      commitView();
    }
    return;
  }
  setPaneRow(paneRow() === index ? null : index);
  haptic(6);
  commitView();
}

export function closeRow(): void {
  if (paneRow() === null) return;
  setPaneRow(null);
  commitView();
}

export async function copyRow(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showStatus(done);
  } catch {
    showError(t("err.copyDenied"));
  }
  setPaneRow(null);
  commitView();
}

export function quoteRow(text: string): void {
  insertCompose(text);
  setPaneRow(null);
  commitView();
}
