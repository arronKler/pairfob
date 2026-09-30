import { createDomain } from "../../shared/model/domain-store";

/** Where a placement tap goes: a split side, or a neighbour to swap with. */
export type BoardPlacementKind = "split" | "swap";

/**
 * Ephemeral board attention; never changes the selected terminal session.
 * `placement` is the canvas mode a menu entry starts (pick where a split goes,
 * or which neighbour to swap with); the canvas reads it, the menu writes it.
 */
const domain = createDomain("boardInteraction", {
  paneId: "",
  createdPaneId: "",
  tabId: "",
  placementKind: "" as BoardPlacementKind | "",
  placementPaneId: "",
});
export const boardInteractionStore = domain.store;
let expiry: ReturnType<typeof setTimeout> | undefined;

export function highlightBoardPane(paneId: string, tabId: string, created = false): void {
  clearTimeout(expiry);
  domain.controller.write(record => {
    record.paneId = paneId;
    record.tabId = tabId;
    record.createdPaneId = created ? paneId : "";
  });
  if (created) expiry = setTimeout(() => {
    domain.controller.write(record => { record.paneId = ""; });
  }, 3000);
}

/** Start picking where a split goes or which neighbour to swap with, on this tab. */
export function startBoardPlacement(kind: BoardPlacementKind, paneId: string, tabId: string): void {
  domain.controller.write(record => {
    record.placementKind = kind;
    record.placementPaneId = paneId;
    record.tabId = tabId;
  });
}

export function endBoardPlacement(): void {
  domain.controller.write(record => { record.placementKind = ""; record.placementPaneId = ""; });
}

export function clearBoardInteraction(): void {
  clearTimeout(expiry);
  domain.controller.write(record => {
    record.paneId = ""; record.createdPaneId = ""; record.tabId = "";
    record.placementKind = ""; record.placementPaneId = "";
  });
}
