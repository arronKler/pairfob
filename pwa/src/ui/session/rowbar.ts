import { button, node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { rowPath, rowText } from "../../lib/termrow";
import { render } from "../../paint";
import { haptic, showError, showStatus, state } from "../../state";
import { insertCompose } from "./compose";
import { toggleTermSelect } from "./term";
import { type PaneModel } from "./model";

export function openRow(index: number): void {
  state.paneRow = state.paneRow === index ? null : index;
  haptic(6);
  render();
}

export function closeRow(): void {
  if (state.paneRow === null) return;
  state.paneRow = null;
  render();
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showStatus(done);
  } catch {
    showError(t("err.copyDenied"));
  }
  state.paneRow = null;
  render();
}

/**
 * Contextual bar for the tapped row. Lives in the pane's flex column rather
 * than floating over the buffer, so acting on a row never hides it.
 */
export function rowBar(model: PaneModel): HTMLElement | null {
  const index = state.paneRow;
  if (index === null) return null;
  const raw = model.texts[index];
  if (raw === undefined) return null;
  const text = rowText(raw);
  if (!text) {
    state.paneRow = null;
    return null;
  }
  const bar = node("div", "row-bar");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", t("row.aria"));
  bar.append(node("p", "row-quote", text));
  const actions = node("div", "row-actions");
  actions.append(button(t("row.copyLine"), "row-act", () => copy(text, t("row.copiedLine"))));
  const path = rowPath(raw);
  if (path) actions.append(button(t("row.copyPath", { path }), "row-act", () => copy(path, t("row.copiedPath"))));
  actions.append(
    button(t("row.quote"), "row-act", () => {
      insertCompose(text);
      state.paneRow = null;
      render();
    }),
  );
  actions.append(button(t("menu.selectText"), "row-act", () => toggleTermSelect(true)));
  actions.append(button(t("close"), "row-act row-act-ghost", closeRow));
  bar.append(actions);
  return bar;
}
