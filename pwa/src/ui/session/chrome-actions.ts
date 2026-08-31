import { button, node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { haptic, state } from "../../state";

/** Right cluster shared by Control / Terminal / Chat: interrupt when working, then this-view menu. */
export function chromeActionCluster(onMenu: () => void): HTMLElement {
  const actions = node("div", "chrome-actions");
  const menu = button("", "icon-btn icon-more", onMenu);
  menu.setAttribute("aria-label", t("pane.menuTitle"));
  menu.disabled = state.operationBusy;
  actions.append(menu);
  return actions;
}

export function syncChromeStop(chrome: HTMLElement, working: boolean, onStop: () => void): void {
  const actions = chrome.querySelector(".chrome-actions");
  const mounted = chrome.querySelector(".icon-stop");
  if (!working) {
    mounted?.remove();
    return;
  }
  if (mounted || !actions) return;
  const stop = button("", "icon-btn icon-stop", () => {
    haptic(10);
    onStop();
  });
  stop.setAttribute("aria-label", t("pane.interrupt"));
  stop.title = t("pane.interruptTitle");
  actions.prepend(stop);
}
