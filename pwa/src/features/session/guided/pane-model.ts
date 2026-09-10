import { dashboardStore } from "../../dashboard/catalog-store";
import { sessionStore } from "../session-store";
import { agentFromDashboardSnapshot } from "../agents";
import {
  paneModelFromText,
  paneReadLinesFromViewport,
  type PaneModel,
  type PaneModelCache,
} from "./model";

export type { PaneModel };

let cached: PaneModelCache | null = null;

/**
 * ANSI parsing runs on every repaint and on every 1.5s pane read, so memoise
 * on the exact buffer we were handed.
 */
export function paneModel(): PaneModel {
  const text = sessionStore.get().paneText;
  const model = paneModelFromText(text, cached);
  cached = { text, model };
  return model;
}

export function paneReadLines(): number {
  const session = sessionStore.get();
  return paneReadLinesFromViewport(
    agentFromDashboardSnapshot(dashboardStore.get(), session.paneId)?.viewportRows,
  );
}
