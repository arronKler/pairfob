import { NO_OPERATION_CAPABILITIES } from "./lib/operations.ts";
import { clearAgentTraceCache } from "./lib/agent-trace-cache.ts";
import { resetPaneView, state } from "./state.ts";

/** Clear data that belongs to one established daemon session. */
export function resetLiveConnectionState(): void {
  clearAgentTraceCache();
  state.live = null;
  state.pushEnabled = null;
  state.pushSubscribed = null;
  state.settingsRequest++;
  state.settingsLoading = false;
  state.devicesError = "";
  state.pushConfigError = "";
  state.herdHost = "";
  state.runtimeKind = "";
  state.relayRttMs = null;
  state.sessionTransport = "relay";
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  state.agentKinds = [];
  state.operationBusy = false;
  state.snapshotPending = false;
  state.agents = [];
  state.runtimeAgentStatuses = {};
  state.completionSeen = {};
  state.paneId = "";
  state.deviceList = [];
  state.lastHerdSig = "";
  resetPaneView();
}
