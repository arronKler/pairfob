import {
  agentTraceDetailState,
  setAgentTraceDetailState,
  type AgentTraceDetailState,
} from "../lib/agent-trace-cache";
import { messageOf } from "../lib/notices";
import { state } from "../state";

export function toolDetailView(paneId: string, detailRef: string): AgentTraceDetailState {
  return agentTraceDetailState(paneId, detailRef);
}

export function loadToolDetail(paneId: string, detailRef: string, changed: () => void): void {
  const session = state.live;
  const current = agentTraceDetailState(paneId, detailRef);
  if (!session || !detailRef || current.status === "loading" || current.status === "ready") return;
  setAgentTraceDetailState(paneId, detailRef, { status: "loading" });
  changed();
  void session.agentTraceDetail(paneId, detailRef).then((detail) => {
    if (state.live !== session || agentTraceDetailState(paneId, detailRef).status !== "loading") return;
    setAgentTraceDetailState(paneId, detailRef, { status: "ready", detail });
    if (state.agentChat && state.paneId === paneId) changed();
  }).catch((error) => {
    if (state.live !== session || agentTraceDetailState(paneId, detailRef).status !== "loading") return;
    setAgentTraceDetailState(paneId, detailRef, { status: "error", message: messageOf(error, "read") });
    if (state.agentChat && state.paneId === paneId) changed();
  });
}
