/**
 * Mutation transport outcomes.
 *
 * A frame that was actually sealed and sent and then lost its transport has an
 * unknown outcome at the computer. That is wire uncertainty, never a replay
 * signal: the caller must reconcile before it tries again.
 */
import { ProtocolError } from "./errors.ts";

const UNCERTAIN_MUTATION_TRANSPORT_CODES = new Set(["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]);

/** Run one mutation transport attempt and preserve whether its encrypted frame was sent. */
export async function trackMutationDelivery<T>(runOnce: (markSent: () => void) => Promise<T>): Promise<T> {
  let sent = false;
  try {
    return await runOnce(() => { sent = true; });
  } catch (error) {
    if (sent && error instanceof ProtocolError && UNCERTAIN_MUTATION_TRANSPORT_CODES.has(error.code)) {
      throw new ProtocolError("unknown_outcome", "连接在确认结果前中断；操作可能已经执行。请先刷新确认，不要立即重试。");
    }
    throw error;
  }
}
