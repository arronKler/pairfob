import type { PaneReadObservation, PaneRefreshRequest } from "./pane-refresh-request";

export const PANE_CHANGE_RETRY_DELAYS_MS = [80, 160, 320] as const;

export type PaneChangeConfirmation = {
  result: "changed" | "unchanged" | "cancelled";
  attempts: number;
  firstReadStartedAt: number | null;
  changedAt: number | null;
};

type ConfirmationOptions = {
  paneId: string;
  baselineHash: string;
  baselineText: string;
  mutationAckAt: number;
  initialRead?: Promise<PaneReadObservation | null>;
  read: (request: PaneRefreshRequest) => Promise<PaneReadObservation | null>;
  isCurrent: () => boolean;
  sleep?: (delayMs: number) => Promise<void>;
};

function screenChanged(observation: PaneReadObservation, baselineHash: string, baselineText: string): boolean {
  if (baselineHash && observation.hash) return observation.hash !== baselineHash;
  return observation.text !== baselineText;
}

/**
 * Confirm a post-mutation screen change with bounded read-only retries. The
 * mutation itself is never replayed; a no-op PageUp/PageDown simply expires.
 */
export async function confirmPaneChange(options: ConfirmationOptions): Promise<PaneChangeConfirmation> {
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let attempts = 0;
  let firstReadStartedAt: number | null = null;
  let notBefore = options.mutationAckAt;

  for (let index = 0; index <= PANE_CHANGE_RETRY_DELAYS_MS.length; index += 1) {
    if (!options.isCurrent()) return { result: "cancelled", attempts, firstReadStartedAt, changedAt: null };
    const observation = index === 0 && options.initialRead
      ? await options.initialRead
      : await options.read({ notBefore, postponeFallback: true });
    if (!observation || observation.paneId !== options.paneId) {
      return { result: "cancelled", attempts, firstReadStartedAt, changedAt: null };
    }
    attempts += 1;
    firstReadStartedAt ??= observation.startedAt;
    if (!options.isCurrent()) return { result: "cancelled", attempts, firstReadStartedAt, changedAt: null };
    if (screenChanged(observation, options.baselineHash, options.baselineText)) {
      return { result: "changed", attempts, firstReadStartedAt, changedAt: observation.completedAt };
    }
    if (index === PANE_CHANGE_RETRY_DELAYS_MS.length) break;
    notBefore = observation.completedAt;
    await sleep(PANE_CHANGE_RETRY_DELAYS_MS[index]!);
  }

  return { result: "unchanged", attempts, firstReadStartedAt, changedAt: null };
}
