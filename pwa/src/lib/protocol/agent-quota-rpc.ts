import { readQuotaReport, type QuotaReport } from "../agent-quota-report";
import { ProtocolError } from "./errors";
import { QuotaStream } from "./quota-stream";

type Read = (op: string, progress?: (result: unknown) => boolean, params?: { compact: true }) => Promise<unknown>;

/** Negotiation belongs to one connection. Errors after progress never downgrade. */
export class AgentQuotaRPC {
  private stream = true;
  private compact = true;
  private wire = { legacy: false };

  reset(): void { this.stream = true; this.compact = true; this.wire = { legacy: false }; }

  async read(rpc: Read, onProgress?: (report: QuotaReport) => void): Promise<QuotaReport> {
    while (this.stream) {
      const decoder = new QuotaStream();
      const compact = this.compact;
      let progressError: Error | null = null;
      let final: QuotaReport | undefined;
      try {
        const value = await rpc("AgentQuotaStream", value => {
          if (progressError) return false;
          try {
            const part = decoder.read(value);
            if (part.done) { final = part.report; return false; }
            onProgress?.(part.report);
            return true;
          } catch (error) {
            // Invalid quota rejects only this read, preserving terminal traffic.
            progressError = error instanceof Error ? error : new ProtocolError("bad_message", String(error));
            return false;
          }
        }, compact ? { compact: true } : undefined);
        if (progressError) throw progressError;
        if (final) return final;
        const part = decoder.read(value);
        if (!part.done) throw new ProtocolError("bad_message", "订阅余量响应未完成");
        return part.report;
      } catch (error) {
        if (decoder.deltas || !(error instanceof ProtocolError)) throw error;
        // An older stream daemon rejects the newly optional parameter. Retry
        // its original empty request only once, before any result was received.
        if (compact && error.code === "invalid_argument") { this.compact = false; continue; }
        if (error.code !== "unknown_op") throw error;
        this.stream = false;
      }
    }
    return readQuotaReport(op => rpc(op), this.wire);
  }
}
