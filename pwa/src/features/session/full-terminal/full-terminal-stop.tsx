import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { useSession } from "../hooks";
import { SendButton, usePaneWorking } from "../guided/compose-controls";
import { cancelStop, sendKind, stopPhaseFor, stopSnapshot, subscribeStop, type StopKey, type StopTarget } from "../guided/session-stop";

/** Esc and Ctrl+C as the bytes a terminal key press writes. */
const STOP_BYTES: Record<StopKey, string> = { esc: "\u001b", "ctrl+c": "\u0003" };

type SendBytes = (text: string, enter: boolean) => boolean;

/** The stop flow's way into the open terminal: a key written into the bridge, exactly what the pad's Esc / Ctrl+C write. */
export function useFullTerminalStopTarget(paneId: string, send: RefObject<SendBytes>): StopTarget | null {
  return useMemo<StopTarget | null>(() => paneId ? {
    paneId,
    sendKey: (key) => { if (!send.current(STOP_BYTES[key], false)) throw new Error("terminal not ready"); },
  } : null, [paneId, send]);
}

/**
 * 停止 beside a live terminal's field, in the dock a mouse drives. Live input
 * has nothing to send, so there is no send button for it to share: it is there
 * while the agent works and for as long as a stop is under way, and absent
 * otherwise. It runs the same two-step flow as the compose form's button.
 */
export function FullTerminalLiveStop({ send }: { send: SendBytes }) {
  const sendRef = useRef(send);
  sendRef.current = send;
  const paneId = useSession().paneId;
  const working = usePaneWorking(paneId);
  const stop = useSyncExternalStore(subscribeStop, stopSnapshot, stopSnapshot);
  const stopTarget = useFullTerminalStopTarget(paneId, sendRef);
  useLayoutEffect(() => () => { cancelStop(); }, [paneId]);
  const kind = sendKind({ hasText: false, ready: 0, submitting: false, waiting: false, live: false, working,
    stop: stopPhaseFor(stop, paneId) });
  if (kind !== "stop" && kind !== "stopping" && kind !== "force") return null;
  return <SendButton kind={kind} percent={0} className="full-terminal-compose-send full-terminal-live-stop"
    onSend={() => undefined} stopTarget={stopTarget} longPressStops={false} />;
}
