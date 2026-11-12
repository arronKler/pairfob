/**
 * The order the herd list last put on screen.
 *
 * Beside the list its order is held by the feed itself; the phone rebuilds the
 * list when the reader comes back, so the row just opened leads it. A control
 * that must keep naming rows in the order the reader saw cannot read the live
 * activation there. The presentation boundary writes this memory once per
 * paint; readers only ask for its stamps.
 */
import { computersStore } from "../computers/catalog-store";
import { runtimeStore } from "../connection/runtime-store";
import { listGroup } from "../settings/preferences-store";
import { holdActivation, type ActivationHold, type TouchedAt } from "../../lib/ranking";

let shown: ActivationHold | null = null;

/** The list a hold belongs to: the computer, its Herdr session, the grouping. */
export function herdListScope(): string {
  return `${computersStore.get().credential?.daemonId ?? ""}\u0000${runtimeStore.get().herdHost}\u0000${listGroup()}`;
}

/** Called by the presentation boundary with the activation the list was drawn by. */
export function rememberShownListOrder(activation: TouchedAt, paneIds: readonly string[]): void {
  shown = { scope: herdListScope(), stamps: { ...activation }, seen: new Set(paneIds) };
}

/**
 * The remembered stamps, with a pane that turned up later taking its live one
 * and keeping it, exactly as the list does. A read of another list falls back
 * to the live activation; the memory itself is never changed here.
 */
export function heldShownListOrder(live: TouchedAt, paneIds: readonly string[]): TouchedAt {
  if (!shown || shown.scope !== herdListScope()) return live;
  return holdActivation(shown, shown.scope, live, paneIds).stamps;
}

export function resetShownListOrder(): void {
  shown = null;
}
