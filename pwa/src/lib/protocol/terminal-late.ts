import { withOperationID } from "../operations";
import { parseTerminalOpenResult } from "./terminal";
import { TERMINAL_RPC_TIMEOUT_MS, type SessionTransport } from "./session-transport";

/** Release only the validated handle on the exact epoch that opened it. */
export function terminalLateCleanup(transport: Pick<SessionTransport, "rpc">, op: string, params: unknown): ((result: unknown) => void) | undefined {
  if (op !== "TerminalOpen" || !params || typeof params !== "object") return undefined;
  const wire = params as { pane_id?: unknown; operation_id?: unknown };
  if (typeof wire.pane_id !== "string" || typeof wire.operation_id !== "string") return undefined;
  const paneId = wire.pane_id, operationId = wire.operation_id;
  return (result) => {
    try {
      const opened = parseTerminalOpenResult(result, paneId, operationId);
      void transport.rpc("TerminalClose", withOperationID({ terminal_id: opened.terminalId }), TERMINAL_RPC_TIMEOUT_MS).catch(() => undefined);
    } catch { /* An invalid late reply grants no authority to close anything. */ }
  };
}
