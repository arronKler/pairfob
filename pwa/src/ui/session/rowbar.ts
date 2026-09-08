import { t } from "../../lib/i18n";
import { rowPath, rowText } from "../../lib/termrow";
import { render } from "../../paint";
import { haptic, showError, showStatus, state } from "../../state";
import { insertCompose } from "./compose";
import { paneModel, type PaneModel } from "./model";

export function rowBarContent(model: PaneModel): { text: string; path: string | null } | null {
  const index = state.paneRow;
  if (index === null) return null;
  const raw = model.texts[index];
  if (raw === undefined) return null;
  const text = rowText(raw);
  if (!text) return null;
  return { text, path: rowPath(raw) };
}

/** Drop a selected row that no longer has copyable text. Never call this from React render. */
export function discardEmptyPaneRow(model: PaneModel): boolean {
  if (state.paneRow === null || rowBarContent(model)) return false;
  state.paneRow = null;
  return true;
}

export function openRow(index: number): void {
  const model = paneModel();
  const raw = model.texts[index];
  const text = raw === undefined ? "" : rowText(raw);
  if (!text) {
    if (state.paneRow !== null) {
      state.paneRow = null;
      render();
    }
    return;
  }
  state.paneRow = state.paneRow === index ? null : index;
  haptic(6);
  render();
}

export function closeRow(): void {
  if (state.paneRow === null) return;
  state.paneRow = null;
  render();
}

export async function copyRow(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showStatus(done);
  } catch {
    showError(t("err.copyDenied"));
  }
  state.paneRow = null;
  render();
}

export function quoteRow(text: string): void {
  insertCompose(text);
  state.paneRow = null;
  render();
}
