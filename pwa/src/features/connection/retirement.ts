/**
 * Session retirement.
 *
 * Leaving a computer — a disconnect, a burned credential, a switch to another
 * daemon — has to drop everything that belonged to that session in one
 * transaction: the live handle, the runtime identity, the advertised
 * capabilities, the herd and board projections, the open pane with its
 * compose/chat/trace state, and the transport facts. Published separately, a
 * subscriber could render a mixed state (a new computer's session wearing the old
 * computer's capabilities), so the whole retirement is one `batch`: every domain
 * is written before any listener runs.
 *
 * The session-scoped caches that
 * are not domain state arrive as ports, so this module never reaches into another
 * slice's DOM, storage or paint loop.
 */
import { resetBoardCatalog } from "../board/layout-store";
import { clearCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { attachLiveSession } from "../computers/catalog-store";
import {
  noteP2PAttempt,
  noteRelayRtt,
  setSessionTransport,
  setTransportSwitching,
} from "./connection-store";
import { resetDashboard } from "../dashboard/catalog-store";
import { resetRuntime } from "./runtime-store";
import { resetObservationLifecycle, resetPaneView, selectPane } from "../session/session-store";
import { batch } from "../../shared/model/domain-store";

export type RetirementPorts = {
  /** A parked compose draft belongs to the retired view incarnation. */
  bumpViewIncarnation(): void;
  clearAgentTraceCache(): void;
  clearBoardPreviews(): void;
};

/** Domain writes only; callers wrap this in their own `batch` for a larger transaction. */
export function retireLiveDomains(): void {
  attachLiveSession(null);
  resetRuntime();
  noteRelayRtt(null);
  setSessionTransport("relay");
  noteP2PAttempt(null);
  setTransportSwitching(false);
  // Capabilities fail closed: an absent advertisement is a refused operation.
  clearCapabilities();
  setOperationBusy(false);
  resetDashboard();
  resetBoardCatalog();
  selectPane("");
  resetPaneView();
  resetObservationLifecycle();
}

export function resetLiveConnection(ports: RetirementPorts): void {
  ports.bumpViewIncarnation();
  ports.clearAgentTraceCache();
  ports.clearBoardPreviews();
  batch(() => {
    retireLiveDomains();
  });
}
