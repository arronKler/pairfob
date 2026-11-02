import {
  parseAgentTraceDetail,
  parseAgentTracePage,
  parseAgentTraceSummaryPage,
  type AgentTraceDetail,
  type AgentTracePage,
} from "../operations";
import { ProtocolError } from "./errors";

type ReadRPC = (op: string, params: Record<string, unknown>) => Promise<unknown>;

/** Rolling compatibility: prefer body-free summaries, but keep old daemons readable. */
export class AgentTraceRPC {
  private summarySupport: "unknown" | "yes" | "no" = "unknown";

  constructor(private readonly rpc: ReadRPC) {}

  /** `sessionIndex` (an older session of the pane) is sent only when given; the legacy op cannot carry it. */
  async read(paneId: string, cursor: string | null = null, limit = 50, sessionIndex?: number): Promise<AgentTracePage> {
    const params = { pane_id: paneId, cursor, limit, ...(sessionIndex === undefined ? {} : { session_index: sessionIndex }) };
    if (sessionIndex !== undefined && this.summarySupport === "no") {
      throw new ProtocolError("unknown_op", "AgentTraceSummary");
    }
    if (this.summarySupport !== "no") {
      try {
        const page = parseAgentTraceSummaryPage(await this.rpc("AgentTraceSummary", params));
        this.summarySupport = "yes";
        return page;
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== "unknown_op") throw error;
        this.summarySupport = "no";
        if (sessionIndex !== undefined) throw error;
      }
    }
    return parseAgentTracePage(await this.rpc("AgentTrace", params));
  }

  async detail(paneId: string, detailRef: string): Promise<AgentTraceDetail> {
    const result = await this.rpc("AgentTraceDetail", { pane_id: paneId, detail_ref: detailRef });
    return parseAgentTraceDetail(result, detailRef);
  }
}
