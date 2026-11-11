/**
 * Runtime observation: GetConfig and the follow-up snapshot/pane reads.
 *
 * Capabilities fail closed before the RPC and on a failed parse. A response
 * whose herd-config generation or live session no longer matches is dropped, so
 * a computer switch cannot install the previous daemon's grants.
 */
import { applyCapabilities, clearCapabilities } from "../operations/capabilities-store";
import { setCredential } from "../computers/catalog-store";
import { applyRuntimeIdentity, runtimeStore, setIdentityPending, setPushEnabled } from "./runtime-store";
import { noticesStore, clearNotice } from "../../app/notices-store";
import { batch } from "../../shared/model/domain-store";
import { FRIENDLY_ERROR } from "../../lib/notices";
import { parseRuntimeOperationsConfig } from "../../lib/operations";
import { CONFIG_RPC_TIMEOUT_MS, ProtocolError, type LiveSession, type PairResult } from "../../lib/protocol/client";
import { herdConfigIsCurrent, nextHerdConfigRequest } from "./generations";
import { rememberPushConfig } from "../settings/push-config";

export type RuntimeObservationPorts = {
  acceptDaemonVersion(config: unknown): void;
  markDaemonConfigIncompatible(): void;
  saveCredential(pair: PairResult): Promise<void>;
  reloadComputers(): Promise<void>;
  refreshFromSession(): Promise<void>;
  commitView(): void;
  currentLive(): LiveSession | null;
  currentCredential(): PairResult | null;
};

/**
 * How long an unanswered first GetConfig reads as "still reading" before the
 * header falls back to "cannot confirm Herdr". The daemon allows its own
 * describe work 12 s and the client's GetConfig deadline sits above that, so
 * this grace ends only after the read itself has given up. A deadline is not a
 * verdict about Herdr.
 */
export const IDENTITY_READ_GRACE_MS = CONFIG_RPC_TIMEOUT_MS + 1_000;

/**
 * A GetConfig that did not answer has not said anything about Herdr. These
 * codes mean "not answered yet" (the client deadline, or a full session
 * queue), so a connected session asks again instead of publishing an empty
 * identity that only an unrelated reconnect would repair.
 */
const TRANSIENT_CONFIG_CODES: ReadonlySet<string> = new Set(["timeout", "backpressure"]);
const IDENTITY_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
let retrySession: LiveSession | null = null;

let identityTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A session's runtime identity is about to be read. Until it answers (or the
 * grace period runs out) an empty runtime kind means "not read yet". Called as
 * the session goes live, before the first paint of the list.
 */
export function beginIdentityRead(): void {
  if (identityTimer) clearTimeout(identityTimer);
  identityTimer = setTimeout(endIdentityRead, IDENTITY_READ_GRACE_MS);
  setIdentityPending(true);
}

export function endIdentityRead(): void {
  if (identityTimer) clearTimeout(identityTimer);
  identityTimer = null;
  setIdentityPending(false);
}

/** The read settled or the session retired: no follow-up observation is owed. */
export function cancelIdentityRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempts = 0;
  retrySession = null;
}

/**
 * Ask the observation again while the session stays up. The last delay
 * repeats, so a path that heals without a new event still repairs the header.
 */
function scheduleIdentityRetry(session: LiveSession, ports: RuntimeObservationPorts): void {
  if (retryTimer) return;
  const delay = IDENTITY_RETRY_DELAYS_MS[Math.min(retryAttempts++, IDENTITY_RETRY_DELAYS_MS.length - 1)];
  retrySession = session;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (ports.currentLive() !== retrySession) {
      cancelIdentityRetry();
      return;
    }
    void refreshRuntimeState(ports).catch(() => undefined);
  }, delay);
}

function transientConfigFailure(error: unknown): boolean {
  return error instanceof ProtocolError && TRANSIENT_CONFIG_CODES.has(error.code);
}

/** The accepted observation still owns the request, session and credential. */
function acceptedStillCurrent(request: number, session: LiveSession, ports: RuntimeObservationPorts): boolean {
  return herdConfigIsCurrent(request) && ports.currentLive() === session;
}

export async function refreshHerdConfig(ports: RuntimeObservationPorts): Promise<boolean> {
  const session = ports.currentLive();
  const request = nextHerdConfigRequest();
  clearCapabilities();
  if (!session) return false;
  // Only an identity never read is "pending"; a known one stays on screen
  // while a foreground recovery re-reads it. A retry keeps the state its first
  // attempt showed instead of starting the reading window over.
  if (!runtimeStore.get().runtimeKind && retryAttempts === 0) beginIdentityRead();
  if (!acceptedStillCurrent(request, session, ports)) return false;
  try {
    const config = await session.getConfig();
    if (!acceptedStillCurrent(request, session, ports)) return false;
    // External daemon-version listeners can reenter here; revalidate after it.
    ports.acceptDaemonVersion(config);
    if (!acceptedStillCurrent(request, session, ports)) return false;
    let operations;
    try {
      operations = parseRuntimeOperationsConfig(config);
    } catch (error) {
      ports.markDaemonConfigIncompatible();
      throw error;
    }
    const hostname = typeof config.hostname === "string" ? config.hostname : "";
    const runtimeKind = typeof config.runtime === "string" ? config.runtime : "";
    // Capture the credential owner before publishing. One batch: subscribers
    // see the accepted observation as one coherent update, never runtime
    // identity without its push flag or capabilities.
    const credential = ports.currentCredential();
    rememberPushConfig(session, config);
    batch(() => {
      applyRuntimeIdentity({ herdHost: hostname, runtimeKind });
      setPushEnabled(config.push_enabled === true);
      applyCapabilities(operations.capabilities, operations.agentKinds);
      endIdentityRead();
    });
    cancelIdentityRetry();
    if (!acceptedStillCurrent(request, session, ports)) return false;
    if (credential && hostname && credential.hostname !== hostname) {
      const updated = { ...credential, hostname, lastSeen: Math.floor(Date.now() / 1000) };
      setCredential(updated);
      if (!acceptedStillCurrent(request, session, ports)) return false;
      await ports.saveCredential(updated).catch(() => undefined);
      if (!acceptedStillCurrent(request, session, ports)) return false;
      await ports.reloadComputers().catch(() => undefined);
      if (!acceptedStillCurrent(request, session, ports)) return false;
    }
    return true;
  } catch (error) {
    if (!acceptedStillCurrent(request, session, ports)) return false;
    if (transientConfigFailure(error) && session.isConnected?.() === true) {
      // The read did not answer; that is not a state Herdr reported. Keep what
      // is known and ask again while this session stays connected. An identity
      // never read stays "pending" until its grace ends, so the header keeps
      // reading instead of flashing the cannot-confirm line on a slow hop.
      scheduleIdentityRetry(session, ports);
      return false;
    }
    batch(() => {
      clearCapabilities();
      applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
      // A definite failure is an answer: the header may say it cannot confirm.
      endIdentityRead();
    });
    cancelIdentityRetry();
    return true;
  }
}

export async function refreshRuntimeState(ports: RuntimeObservationPorts): Promise<void> {
  const session = ports.currentLive();
  const updated = await refreshHerdConfig(ports);
  if (!updated || ports.currentLive() !== session) return;
  const notice = noticesStore.get().notice;
  if (runtimeStore.get().runtimeKind === "herdr" && notice?.text === FRIENDLY_ERROR.herdr_offline) clearNotice();
  ports.commitView();
  await ports.refreshFromSession();
}
