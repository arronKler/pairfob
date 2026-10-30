import { clearAgentTraceCache } from "../../lib/agent-trace-cache";
import { resetHerdAttention } from "../../lib/herd-attention";
import { bumpViewIncarnation } from "../session/drafts/compose-drafts";
import { clearBoardPreviews } from "../board/preview/store";
import { clearPaneBufferCache } from "../session/pane-buffer";
import { resetLiveConnection, type RetirementPorts } from "./retirement";

/**
 * Session retirement composition root.
 *
 * `features/connection/retirement.ts` owns the transaction. This file supplies
 * the session-scoped caches that are not domain state. Observation flags
 * (`snapshotPending` / pane-read busy) retire through session typed actions.
 * The composition lives beside the controller so the root `live-state.ts` shim
 * can forward the one public name for the final consumer sweep.
 */
const ports: RetirementPorts = {
  bumpViewIncarnation,
  clearAgentTraceCache,
  clearBoardPreviews,
  clearHerdAttention: resetHerdAttention,
  clearPaneBufferCache,
};

/** Clear data that belongs to one established daemon session. Callers park drafts first. */
export function resetLiveConnectionState(): void {
  resetLiveConnection(ports);
}
