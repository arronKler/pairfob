import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { markdownEl } from "../lib/agent-markdown";
import { spinnerNode } from "./chrome";
import {
  groupAgentTurns,
  groupAgentTurnBlocks,
  processTitle,
  replyText,
  stepKey,
  stepSummary,
  toolState,
  turnKey,
  type AgentTurn,
  type AgentTurnBlock,
} from "../lib/agent-trace-view";
import type { AgentTraceItem } from "../lib/operations";
import type { AgentTraceDetailState } from "../lib/agent-trace-cache";
import { state } from "../state";

export type DetailsState = {
  open: Set<string>;
  closed: Set<string>;
};

export function emptyDetails(): DetailsState {
  return { open: new Set(), closed: new Set() };
}

export function readDetailsState(stream: HTMLElement | null): DetailsState {
  const open = new Set<string>();
  const closed = new Set<string>();
  if (!stream) return { open, closed };
  for (const nodeEl of stream.querySelectorAll("details[data-key]")) {
    const card = nodeEl as HTMLDetailsElement;
    const key = card.dataset.key;
    if (!key) continue;
    if (card.dataset.autoOpen === "1") {
      if (card.dataset.user === "closed") closed.add(key);
      else if (card.dataset.user === "open") open.add(key);
      continue;
    }
    if (card.dataset.user === "closed") closed.add(key);
    else if (card.open || card.dataset.user === "open") open.add(key);
  }
  return { open, closed };
}

function bindToggle(card: HTMLDetailsElement): void {
  card.addEventListener("toggle", () => {
    if (card.dataset.autoOpen === "1" && card.open) return;
    card.dataset.user = card.open ? "open" : "closed";
    delete card.dataset.autoOpen;
  });
}

function applyOpen(card: HTMLDetailsElement, key: string, auto: boolean, kept: DetailsState): void {
  card.dataset.key = key;
  if (kept.closed.has(key)) {
    card.dataset.user = "closed";
    card.open = false;
  } else if (kept.open.has(key)) {
    card.dataset.user = "open";
    card.open = true;
  } else if (auto) {
    card.dataset.autoOpen = "1";
    card.open = true;
  } else {
    card.open = false;
  }
  bindToggle(card);
}

function toolStateMark(item: AgentTraceItem): HTMLElement {
  const status = toolState(item);
  const label = status === "running"
    ? t("trace.runningTool")
    : status === "error"
      ? t("trace.failedTool")
      : t("trace.doneTool");
  const mark = node("span", `agent-tool-state agent-tool-state-${status}`);
  mark.setAttribute("aria-label", label);
  mark.title = label;
  if (status === "running") mark.append(spinnerNode());
  else mark.textContent = status === "error" ? "!" : "✓";
  return mark;
}

function thinkingPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type ToolDetailHooks = {
  view?: (item: AgentTraceItem) => AgentTraceDetailState;
  need?: (detailRef: string) => void;
};

function appendToolFields(card: HTMLElement, item: AgentTraceItem, detail: AgentTraceDetailState): void {
  const body = detail.detail;
  const text = body?.text ?? item.text;
  const input = body?.input ?? item.input;
  const output = body?.output ?? item.output;
  if (input) {
    card.append(node("p", "agent-step-label", t("chat.params")));
    card.append(node("pre", "agent-step-body", input));
  }
  if (output) {
    card.append(node("p", "agent-step-label", t("chat.result")));
    card.append(node("pre", "agent-step-body", output));
  }
  if (!input && !output && text) card.append(node("pre", "agent-step-body", text));
  if (body?.truncated) card.append(node("p", "agent-detail-limit", t("chat.truncated")));
}

function appendLazyToolState(card: HTMLElement, item: AgentTraceItem, detail: AgentTraceDetailState, hooks: ToolDetailHooks): void {
  if (!item.detailRef) {
    appendToolFields(card, item, detail);
    return;
  }
  if (detail.status === "ready") {
    appendToolFields(card, item, detail);
    return;
  }
  if (detail.status === "loading") {
    const loading = node("div", "agent-detail-state");
    loading.setAttribute("role", "status");
    loading.append(spinnerNode(), node("span", "", t("chat.detailLoading")));
    card.append(loading);
    return;
  }
  if (detail.status === "error") {
    const failed = node("div", "agent-detail-state agent-detail-error");
    failed.setAttribute("role", "alert");
    failed.append(node("span", "", detail.message || t("chat.detailFailed")));
    const retry = button(t("retry"), "btn btn-small agent-detail-retry", () => hooks.need?.(item.detailRef!));
    retry.type = "button";
    failed.append(retry);
    card.append(failed);
  }
}

function stepCard(item: AgentTraceItem, index: number, scope: string, kept: DetailsState, hooks: ToolDetailHooks): HTMLElement {
  const status = item.type === "tool" ? ` is-${toolState(item)}` : "";
  const card = node("details", `agent-step agent-${item.type}${status}`);
  applyOpen(card, stepKey(item, index, scope), false, kept);
  const summary = node("summary", "agent-step-summary");
  if (item.type === "tool") summary.append(toolStateMark(item));
  summary.append(node("span", "agent-step-title", stepSummary(item)));
  if (item.type === "thinking" && item.text) {
    const previewText = thinkingPreview(item.text);
    const preview = node("span", "agent-thinking-preview", previewText);
    preview.title = previewText;
    summary.append(preview);
  }
  card.append(summary);
  if (item.type === "thinking" && item.text) card.append(node("pre", "agent-step-body", item.text));
  if (item.type === "tool") {
    const detail = hooks.view?.(item) ?? { status: item.detailRef ? "idle" : "ready" };
    appendLazyToolState(card, item, detail, hooks);
    if (item.detailRef) {
      const request = () => {
        if (card.open) hooks.need?.(item.detailRef!);
      };
      card.addEventListener("toggle", request);
      if (card.open && detail.status === "idle") queueMicrotask(request);
    }
  }
  return card;
}

function appendProcessItems(
  items: AgentTraceItem[],
  kept: DetailsState,
  body: HTMLElement,
  scope: string,
  hooks: ToolDetailHooks,
  offset = 0,
): number {
  for (const [index, item] of items.entries()) body.append(stepCard(item, offset + index, scope, kept, hooks));
  return offset + items.length;
}

function processCard(
  turn: AgentTurn,
  items: AgentTraceItem[],
  blockIndex: number,
  live: boolean,
  kept: DetailsState,
  hooks: ToolDetailHooks,
): HTMLElement {
  const scope = `${turnKey(turn)}:${blockIndex}`;
  const card = node("details", "agent-process");
  applyOpen(card, `p:${scope}`, live, kept);
  card.append(node("summary", "agent-process-summary", processTitle(items, live)));
  const body = node("div", "agent-process-body");
  appendProcessItems(items, kept, body, scope, hooks);
  card.append(body);
  return card;
}

function userBubble(item: AgentTraceItem): HTMLElement {
  const article = node("article", "agent-user");
  article.append(node("div", "agent-user-text", item.text || ""));
  return article;
}

function assistantReply(
  items: AgentTraceItem[],
  final: boolean,
  live: boolean,
  onCopy?: (text: string) => void | Promise<void>,
): HTMLElement {
  const text = replyText(items);
  const article = node("article", `agent-assistant${final ? " agent-assistant-final" : " agent-assistant-intermediate"}`);
  article.append(markdownEl(text));
  if (final && !live && onCopy && text) {
    const actions = node("div", "agent-reply-actions");
    const copy = button(t("chat.copyReply"), "agent-reply-copy", () => onCopy(text));
    copy.setAttribute("aria-label", t("chat.copyReplyAria"));
    actions.append(copy);
    article.append(actions);
  }
  return article;
}

function foldTitle(blocks: AgentTurnBlock[]): string {
  const count = blocks.reduce((total, block) => total + block.items.length, 0);
  return t("trace.nSteps", { n: count });
}

function appendFoldBlock(
  block: AgentTurnBlock,
  kept: DetailsState,
  into: HTMLElement,
  scope: string,
  offset: number,
  hooks: ToolDetailHooks,
  onCopy?: (text: string) => void | Promise<void>,
): number {
  if (block.type === "reply") {
    into.append(assistantReply(block.items, false, false, onCopy));
    return offset + block.items.length;
  }
  return appendProcessItems(block.items, kept, into, scope, hooks, offset);
}

function processFold(
  turn: AgentTurn,
  blocks: AgentTurnBlock[],
  kept: DetailsState,
  hooks: ToolDetailHooks,
  onCopy?: (text: string) => void | Promise<void>,
): HTMLElement {
  const card = node("details", "agent-process agent-reply-fold");
  applyOpen(card, `f:${turnKey(turn)}`, false, kept);
  const summary = node("summary", "agent-process-summary agent-reply-fold-summary");
  summary.append(node("span", "agent-reply-fold-title", foldTitle(blocks)));
  const body = node("div", "agent-process-body agent-reply-fold-body");
  let offset = 0;
  for (const block of blocks) offset = appendFoldBlock(block, kept, body, turnKey(turn), offset, hooks, onCopy);
  card.append(summary, body);
  return card;
}

function runStatus(stepCount: number): HTMLElement {
  const status = node("div", "agent-run-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const label = stepCount ? t("trace.runningSteps", { n: stepCount }) : t("chat.runningEllipsis");
  status.append(spinnerNode(), node("span", "", label));
  return status;
}

function paintTurn(
  turn: AgentTurn,
  live: boolean,
  kept: DetailsState,
  into: HTMLElement,
  hooks: ToolDetailHooks,
  onCopy?: (text: string) => void | Promise<void>,
): void {
  if (turn.user) into.append(userBubble(turn.user));
  const blocks = groupAgentTurnBlocks(turn.items);
  const finalReply = !live && blocks.at(-1)?.type === "reply" ? blocks.length - 1 : -1;
  if (finalReply > 0) into.append(processFold(turn, blocks.slice(0, finalReply), kept, hooks, onCopy));
  if (finalReply >= 0) {
    into.append(assistantReply(blocks[finalReply].items, true, live, onCopy));
  } else {
    let lastProcess = -1;
    for (const [index, block] of blocks.entries()) if (block.type === "process") lastProcess = index;
    for (const [index, block] of blocks.entries()) {
      if (block.type === "process") into.append(processCard(turn, block.items, index, live && index === lastProcess, kept, hooks));
      else into.append(assistantReply(block.items, false, live, onCopy));
    }
  }
  if (live) into.append(runStatus(turn.items.length));
}

export type AgentEmptyKind = "loading" | "working" | "empty" | "error";

export type AgentEmptySpec = {
  kind: AgentEmptyKind;
  title: string;
  sub?: string;
};

function emptyPanel(spec: AgentEmptySpec, onRetry?: () => void): HTMLElement {
  const panel = node("div", `agent-empty agent-empty-${spec.kind}`);
  panel.setAttribute("role", spec.kind === "error" ? "alert" : "status");
  if (spec.kind === "loading" || spec.kind === "working") panel.append(spinnerNode());
  panel.append(node("p", "agent-empty-title", spec.title));
  if (spec.sub) panel.append(node("p", "agent-empty-sub", spec.sub));
  if (spec.kind === "error" && onRetry) {
    const retry = button(t("retry"), "btn btn-small", onRetry);
    retry.type = "button";
    panel.append(retry);
  }
  return panel;
}

export function paintAgentStream(opts: {
  items: AgentTraceItem[];
  working: boolean;
  empty: AgentEmptySpec;
  busy?: boolean;
  kept?: DetailsState;
  onRetry?: () => void;
  onNeedOlder?: () => void;
  onFollow?: (follow: boolean) => void;
  onCopyReply?: (text: string) => void | Promise<void>;
  toolDetail?: (item: AgentTraceItem) => AgentTraceDetailState;
  onNeedToolDetail?: (detailRef: string) => void;
  truncated?: boolean;
}): HTMLElement {
  const stream = node("div", "agent-stream");
  const inner = node("div", "agent-stream-inner");
  stream.setAttribute("role", "log");
  stream.setAttribute("aria-label", t("chat.streamAria"));
  stream.setAttribute("aria-busy", String(opts.busy === true));
  stream.tabIndex = 0;
  const kept = opts.kept ?? emptyDetails();
  const hooks = { view: opts.toolDetail, need: opts.onNeedToolDetail };
  if (!opts.items.length) inner.append(emptyPanel(opts.empty, opts.onRetry));
  if (opts.truncated && opts.items.length) {
    inner.append(node("p", "agent-trace-limit", t("chat.truncated")));
  }
  const turns = groupAgentTurns(opts.items);
  for (const [index, turn] of turns.entries()) {
    paintTurn(turn, opts.working && index === turns.length - 1, kept, inner, hooks, opts.onCopyReply);
  }
  stream.append(inner);
  stream.addEventListener("scroll", () => {
    const follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 32;
    state.agentTraceFollow = follow;
    opts.onFollow?.(follow);
    if (stream.scrollTop < 32) opts.onNeedOlder?.();
  }, { passive: true });
  return stream;
}
