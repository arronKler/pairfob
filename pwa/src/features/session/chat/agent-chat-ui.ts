import { flushSync } from "react-dom";

let revision = 0;
const listeners = new Set<() => void>();
export function agentChatUIRevision(): number { return revision; }
export function subscribeAgentChatUI(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishAgentChatUI(): void {
  revision++;
  flushSync(() => { for (const listener of listeners) listener(); });
}
