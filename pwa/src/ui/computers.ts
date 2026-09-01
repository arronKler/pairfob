import { beginAddComputer, forgetComputer, switchComputer } from "../computers";
import { computerTitle } from "../lib/computer-catalog";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { formatDeviceAge } from "../lib/ui-model";
import { render } from "../paint";
import { app, state } from "../state";
import { isDesk } from "../viewport";
import { appendNotice, backBar, brandNode, chevron } from "./chrome";

function computerMeta(daemonId: string, lastSeen?: number): string {
  const current = state.phase === "live" && state.credential?.daemonId === daemonId;
  if (current) return t("computers.current");
  if (state.lastUsedDaemonId === daemonId) return t("computers.lastUsed", { when: formatDeviceAge(lastSeen) });
  return lastSeen ? t("device.lastUsed", { when: formatDeviceAge(lastSeen) }) : t("computers.neverConnected");
}

function computerRow(pair: typeof state.computers[number]): HTMLElement {
  const current = state.phase === "live" && state.credential?.daemonId === pair.daemonId;
  const row = node("div", "computer-row");
  const select = button("", `switch-item${current ? " on" : ""}`, () => void switchComputer(pair.daemonId));
  const main = node("span", "switch-main");
  const head = node("span", "switch-head");
  head.append(node("span", "switch-name", computerTitle(pair)));
  if (current) head.append(node("span", "pill pill-live", t("computers.currentPill")));
  main.append(head, node("span", "switch-meta", computerMeta(pair.daemonId, pair.lastSeen || pair.createdAt)));
  select.append(main, chevron());
  const forget = button(t("forget"), "computer-forget", () => void forgetComputer(pair.daemonId));
  forget.setAttribute("aria-label", t("computers.forgetAria", { title: computerTitle(pair) }));
  row.append(select, forget);
  return row;
}

function addComputerRow(): HTMLButtonElement {
  const add = button("", "switch-item computer-add", beginAddComputer);
  const mark = node("span", "add-mark");
  mark.setAttribute("aria-hidden", "true");
  const main = node("span", "switch-main");
  const head = node("span", "switch-head");
  head.append(node("span", "switch-name", t("settings.addComputer")));
  main.append(head, node("span", "switch-meta", t("computers.addHint")));
  add.append(mark, main, chevron());
  return add;
}

export function fillComputers(container: HTMLElement | DocumentFragment, withBack: boolean): void {
  if (withBack) {
    container.append(
      backBar(t("computers.title"), () => {
        state.screen = isDesk() && state.paneId ? "pane" : "home";
        render();
      }),
    );
  } else {
    container.append(brandNode());
    container.append(node("h1", "prelude-title", state.computers.length > 1 ? t("computers.pick") : t("computers.offlineTitle")));
    container.append(
      node(
        "p",
        "lede",
        state.computers.length > 1 ? t("computers.multiLede") : t("computers.offlineLede"),
      ),
    );
  }
  appendNotice(container);
  const list = node("div", "computer-list");
  state.computers.forEach((pair) => list.append(computerRow(pair)));
  container.append(list, addComputerRow());
}

export function renderComputers(): void {
  const root = node("div", state.phase === "live" ? "page settings-page" : "page");
  fillComputers(root, state.phase === "live");
  app.replaceChildren(root);
}
