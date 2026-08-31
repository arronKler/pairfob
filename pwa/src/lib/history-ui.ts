import { button, node } from "./dom.ts";
import { t } from "./i18n.ts";
import { messageOf } from "./notices.ts";
import { parseHistoryPage, type HistoryItem, type HistoryPage } from "./operations.ts";
import { ProtocolError } from "./protocol/errors.ts";

/** Frozen first window for rendered terminal history. The phone cannot pick a line count. */
export const TERMINAL_HISTORY_CURSOR = "term:v1:200";

type HistoryLoader = (cursor: string | null) => Promise<unknown>;
type HistoryMode = "conversation" | "terminal";

let historySerial = 0;

export type HistoryLoaders = {
  conversation?: HistoryLoader;
  terminal?: HistoryLoader;
};

type ModeState = {
  loaded: boolean;
  loading: boolean;
  items: HistoryItem[];
  text: string;
  nextCursor: string | null;
  truncated: boolean;
  error: string;
};

function freshMode(): ModeState {
  return { loaded: false, loading: false, items: [], text: "", nextCursor: null, truncated: false, error: "" };
}

function terminalError(error: unknown): string {
  if (error instanceof ProtocolError && error.code === "conflict") {
    return t("hist.terminalBusy");
  }
  if (error instanceof ProtocolError && error.code === "unsupported") {
    return t("hist.terminalUnsupported");
  }
  return messageOf(error, "read");
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

function dialogTitle(modes: HistoryMode[]): string {
  if (modes.length === 1 && modes[0] === "terminal") return t("hist.earlier");
  if (modes.length === 1 && modes[0] === "conversation") return t("hist.conversation");
  return t("hist.session");
}

function historyDialog(heading: string): { dialog: HTMLDialogElement; body: HTMLDivElement; close: () => void } {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal operation-modal history-modal");
  const titleID = `history-dialog-title-${++historySerial}`;
  dialog.setAttribute("aria-labelledby", titleID);
  const form = node("form");
  form.method = "dialog";
  form.addEventListener("submit", (event) => event.preventDefault());
  const title = node("h2", "modal-title", heading);
  title.id = titleID;
  const body = node("div", "operation-body");
  form.append(title, body);
  dialog.append(form);
  const close = () => dialog.close("close");
  dialog.addEventListener("close", () => {
    dialog.remove();
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close };
}

export async function showHistory(loaders: HistoryLoaders): Promise<void> {
  const availableModes: HistoryMode[] = [
    ...(loaders.conversation ? (["conversation"] as const) : []),
    ...(loaders.terminal ? (["terminal"] as const) : []),
  ];
  if (!availableModes.length) return;
  const parts = historyDialog(dialogTitle(availableModes));
  let mode: HistoryMode = availableModes[0];
  const states: Record<HistoryMode, ModeState> = { conversation: freshMode(), terminal: freshMode() };

  const tabs = node("div", "history-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("hist.typeAria"));
  const status = node("p", "notice notice-status", t("hist.loading"));
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const viewport = node("div", "history-viewport");
  viewport.id = "history-panel";
  viewport.setAttribute("role", "tabpanel");
  const footer = node("div", "action-row history-actions");
  const close = button(t("hist.backLive"), "btn btn-small btn-ghost", parts.close);
  const more = button(t("hist.loadMore"), "btn btn-small btn-primary", () => void readNext());
  footer.append(more, close);
  if (availableModes.length > 1) parts.body.append(tabs);
  parts.body.append(status, viewport, footer);

  const tabButtons = new Map<HistoryMode, HTMLButtonElement>();
  for (const item of availableModes) {
    const label = item === "conversation" ? t("hist.conversationTab") : t("hist.terminalTab");
    const tab = button(label, "history-tab", () => void selectMode(item));
    tab.id = `history-tab-${item}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", viewport.id);
    tabs.append(tab);
    tabButtons.set(item, tab);
  }

  function paintConversation(state: ModeState): void {
    const list = node("ol", "history-list");
    for (const item of state.items) {
      const row = node("li", `history-item history-${item.role}`);
      row.append(node("strong", "history-role", item.role === "user" ? t("hist.you") : "Agent"));
      row.append(node("pre", "history-text", item.text));
      list.append(row);
    }
    viewport.replaceChildren(list);
  }

  function paintTerminal(state: ModeState): void {
    const terminal = node("pre", "terminal-history-text", state.text);
    terminal.tabIndex = 0;
    terminal.setAttribute("aria-label", t("hist.terminalAria"));
    viewport.replaceChildren(terminal);
  }

  function statusText(state: ModeState): string {
    if (state.loading) return mode === "terminal" ? t("hist.loadingTerm") : t("hist.loadingChat");
    if (state.error) return state.error;
    if (mode === "terminal") {
      const rows = lineCount(state.text);
      if (!rows) return t("hist.noTerm");
      if (state.truncated && state.nextCursor) return t("hist.recentRows", { n: rows });
      if (state.truncated) return t("hist.recentCapped", { n: rows });
      return t("hist.readRows", { n: rows });
    }
    if (!state.items.length) return t("hist.noChat");
    return state.truncated
      ? t("hist.readItemsTrunc", { n: state.items.length })
      : t("hist.readItems", { n: state.items.length });
  }

  function paint(): void {
    const state = states[mode];
    for (const [item, tab] of tabButtons) {
      const active = item === mode;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    status.className = `notice ${state.error ? "notice-error" : "notice-status"}`;
    status.setAttribute("role", state.error ? "alert" : "status");
    status.textContent = statusText(state);
    parts.body.setAttribute("aria-busy", String(state.loading));
    viewport.setAttribute("aria-busy", String(state.loading));
    viewport.setAttribute("aria-labelledby", `history-tab-${mode}`);
    const hasContent = mode === "terminal" ? state.text !== "" : state.items.length > 0;
    if (!hasContent) viewport.replaceChildren();
    else if (mode === "terminal") paintTerminal(state);
    else paintConversation(state);
    more.textContent = state.error ? t("retry") : mode === "terminal" ? t("hist.loadEarlier") : t("hist.loadMore");
    more.hidden = !state.error && !state.nextCursor;
    more.disabled = state.loading;
  }

  function applyPage(page: HistoryPage, append: boolean): void {
    const state = states[mode];
    if (mode === "terminal") {
      state.text = page.items.map((item) => item.text).join("\n");
      state.truncated = page.truncated;
    } else {
      state.items = append ? [...state.items, ...page.items] : page.items;
      state.truncated = state.truncated || page.truncated;
    }
    state.nextCursor = page.nextCursor;
    state.loaded = true;
  }

  async function readNext(): Promise<void> {
    const state = states[mode];
    if (state.loading) return;
    const loadingMode = mode;
    const loader = loadingMode === "terminal" ? loaders.terminal : loaders.conversation;
    if (!loader) return;
    const cursor = state.loaded
      ? state.nextCursor
      : loadingMode === "terminal"
        ? TERMINAL_HISTORY_CURSOR
        : null;
    if (state.loaded && !cursor) return;
    state.loading = true;
    state.error = "";
    paint();
    try {
      const page = parseHistoryPage(await loader(cursor));
      if (mode === loadingMode) applyPage(page, state.loaded && loadingMode === "conversation");
    } catch (error) {
      state.error = loadingMode === "terminal" ? terminalError(error) : messageOf(error, "read");
    } finally {
      state.loading = false;
      if (mode === loadingMode) paint();
    }
  }

  async function selectMode(next: HistoryMode): Promise<void> {
    mode = next;
    paint();
    if (!states[next].loaded && !states[next].loading) await readNext();
  }

  paint();
  close.focus();
  await readNext();
}
