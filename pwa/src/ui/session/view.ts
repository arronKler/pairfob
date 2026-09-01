import { agentMeta, agentTitle, chromeName, cwdName, statusLabel, tabIsSplit } from "../../lib/dashboard";
import { button, node } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { type AgentCard } from "../../lib/ranking";
import { app, selectedAgent, state } from "../../state";
import { isDesk } from "../../viewport";
import { appendNotice, backButton } from "../chrome";
import { chromeActionCluster, syncChromeStop } from "./chrome-actions";
import { composeField, sizeCompose, syncSendButton } from "./compose";
import { dockNode } from "./dock";
import { queueKey } from "./keys";
import { paneModel, type PaneModel } from "./model";
import { openRow, rowBar } from "./rowbar";
import { atBottom, fillTerm, restoreTermScroll, sessionScroll, stickBottom, syncJump, termElement, termView, toggleTermSelect } from "./term";

export type SessionHandlers = {
  onBack: () => void;
  onMenu: () => void;
  onSwitch: () => void;
};

function statusLine(selected: AgentCard): string {
  return [statusLabel(selected.status), agentMeta(selected)].filter(Boolean).join(" · ");
}

function chromeMeta(selected: AgentCard): string {
  return [statusLabel(selected.status), cwdName(selected.cwd), tabIsSplit(selected, state.agents) ? t("chrome.split") : ""]
    .filter(Boolean)
    .join(" · ");
}

function titleBody(selected: AgentCard): HTMLElement[] {
  const name = node("span", "chrome-name", chromeName(selected));
  const line = chromeMeta(selected);
  if (!line) return [name];
  const meta = node("span", "chrome-meta");
  meta.append(node("span", `agent-dot agent-${selected.status}`), node("span", "chrome-meta-text", line));
  return [name, meta];
}

/**
 * The accessible name and the interrupt button carry the same status the dot
 * shows. Both the builder and the in-place patch go through here, because a
 * status flip seen while the pane is open only ever runs the patch.
 */
function syncChromeStatus(chrome: HTMLElement, title: HTMLElement, selected: AgentCard): void {
  const line = statusLine(selected);
  title.title = [agentTitle(selected), line].filter(Boolean).join(" · ");
  title.setAttribute(
    "aria-label",
    line ? t("chrome.switchAriaMeta", { title: agentTitle(selected), line }) : t("chrome.switchAria", { title: agentTitle(selected) }),
  );
  syncChromeStop(chrome, selected.status === "working", () => queueKey("esc"));
}

function chromeNode(selected: AgentCard | undefined, includeBack: boolean, handlers: SessionHandlers): HTMLElement {
  const chrome = node("header", "chrome");
  if (includeBack) {
    chrome.append(backButton(handlers.onBack, t("chrome.backList")));
  }
  const title = node("button", "chrome-title");
  title.type = "button";
  title.addEventListener("click", handlers.onSwitch);
  title.append(...(selected ? titleBody(selected) : [node("span", "chrome-name", t("title.session"))]));
  chrome.append(title);
  chrome.append(chromeActionCluster(handlers.onMenu));
  if (selected) syncChromeStatus(chrome, title, selected);
  return chrome;
}

function fillExtras(host: HTMLElement, model: PaneModel): void {
  const parts: HTMLElement[] = [];
  const bar = rowBar(model);
  if (bar) parts.push(bar);
  host.replaceChildren(...parts);
}

function selectBar(): HTMLElement {
  const bar = node("div", "select-bar");
  bar.append(node("p", "select-hint", t("term.selectHint")));
  bar.append(button(t("term.done"), "btn btn-small", () => toggleTermSelect(false)));
  return bar;
}

export function fillSession(
  container: HTMLElement | DocumentFragment,
  selected: AgentCard | undefined,
  includeBack: boolean,
  handlers: SessionHandlers,
): HTMLTextAreaElement | undefined {
  container.append(chromeNode(selected, includeBack, handlers));
  if (!selected) {
    container.append(node("p", "empty-sub", t("err.paneGone")));
    return;
  }
  appendNotice(container);
  const model = paneModel();
  container.append(termView(model, openRow));
  const extras = node("div", "session-extras");
  fillExtras(extras, model);
  container.append(extras);
  if (state.termSelect) {
    container.append(selectBar());
    return;
  }
  const { dock, input } = dockNode(includeBack);
  container.append(dock);
  return input;
}

export function finishSessionPaint(scroll: { top: number; left: number; bottom: boolean }, input?: HTMLTextAreaElement): void {
  if (state.agentChat) return;
  const term = termElement();
  if (term) {
    restoreTermScroll(term, scroll);
    state.paneFollow = scroll.bottom;
    if (state.paneFollow) state.paneUnread = false;
    syncJump();
  }
  const field = input ?? composeField();
  if (field) {
    sizeCompose(field);
    if (state.composeFocused || isDesk()) {
      field.focus({ preventScroll: true });
      const caret = field.value.length;
      field.setSelectionRange(caret, caret);
    }
  }
}

export function patchChromeTitle(): void {
  const chrome = app.querySelector(".chrome") as HTMLElement | null;
  const wrap = app.querySelector(".chrome-title") as HTMLElement | null;
  const selected = selectedAgent();
  if (!chrome || !wrap || !selected) return;
  wrap.replaceChildren(...titleBody(selected));
  syncChromeStatus(chrome, wrap, selected);
}

/** In-place buffer update that keeps scroll, selection and a typed draft. */
export function patchSessionScreen(): boolean {
  const term = termElement();
  const extras = app.querySelector(".session-extras") as HTMLElement | null;
  if (!term || !extras || state.screen !== "pane") return false;
  // Repainting rows would collapse an in-progress text selection.
  if (state.termSelect) return true;
  const following = atBottom(term);
  const left = term.scrollLeft;
  const top = term.scrollTop;
  const model = paneModel();
  fillTerm(term, model);
  fillExtras(extras, model);
  syncSendButton();
  patchChromeTitle();
  restoreTermScroll(term, { left, top, bottom: following });
  if (following) {
    state.paneFollow = true;
    state.paneUnread = false;
  } else {
    state.paneFollow = false;
    state.paneUnread = true;
  }
  syncJump();
  return true;
}

export { sessionScroll, stickBottom };
