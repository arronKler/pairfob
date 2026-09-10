/**
 * Pure agent-chat view helpers. Take explicit inputs; do not import state, paint, or DOM.
 */

export type AgentEmptyKind = "loading" | "working" | "empty" | "error";
export type AgentEmptySpec = { kind: AgentEmptyKind; title: string; sub?: string };
export type AgentChatLoadState = "cold" | "loading" | "ready" | "error";

export type AgentEmptyCopy = {
  running: string;
  reading: string;
  noChat: string;
  willWrite: string;
  sendBelow: string;
  cantSend: string;
};

export type AgentEmptyInput = {
  working: boolean;
  loadState: AgentChatLoadState;
  note: string;
  unavailableNote: string;
  canSend: boolean;
  copy: AgentEmptyCopy;
};

export function agentEmptySpec(input: AgentEmptyInput): AgentEmptySpec {
  const { working, loadState, note, unavailableNote, canSend, copy } = input;
  if (loadState === "error" && note && note !== unavailableNote) {
    return { kind: "error", title: note };
  }
  if (working) return { kind: "working", title: copy.running };
  if (loadState === "cold" || loadState === "loading") {
    return { kind: "loading", title: copy.reading };
  }
  if (note === unavailableNote) return { kind: "empty", title: copy.noChat, sub: copy.willWrite };
  if (note) return { kind: "empty", title: copy.noChat, sub: note };
  return {
    kind: "empty",
    title: copy.noChat,
    sub: canSend ? copy.sendBelow : copy.cantSend,
  };
}

export function agentStreamSignature(
  items: unknown[],
  working: boolean,
  loadState: string,
  truncated: boolean,
  detailRevision: number,
): string {
  return `${JSON.stringify(items)}|${working ? 1 : 0}|${loadState}|${truncated ? 1 : 0}|${detailRevision}`;
}
