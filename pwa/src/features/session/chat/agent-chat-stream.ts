import { type DetailsState } from "./details";

export type { DetailsState } from "./details";
export { chatDetailsState, emptyDetailsState } from "./details";
export type { AgentEmptyKind, AgentEmptySpec } from "./model";

/** Test/legacy DOM snapshot. Production chat must not call this during render. */
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
