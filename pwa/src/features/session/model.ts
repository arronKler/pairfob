import type { SessionViewKind } from "./ports";

export type { SessionViewKind } from "./ports";

/** Screen composition: complete-terminal wins, then agent chat, then guided. */
export function sessionViewKind(flags: { agentChat?: boolean; fullTerminal?: boolean }): SessionViewKind {
  if (flags.fullTerminal) return "full";
  if (flags.agentChat) return "agent";
  return "guided";
}

/**
 * Draft identity prefers agent chat over complete-terminal. Product flags are
 * exclusive; this order matches the existing compose-draft scope.
 */
export function composeDraftMode(flags: { agentChat?: boolean; fullTerminal?: boolean }): SessionViewKind {
  if (flags.agentChat) return "agent";
  if (flags.fullTerminal) return "full";
  return "guided";
}
