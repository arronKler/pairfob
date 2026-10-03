/**
 * Shared attachment scope/session/capability gates and the transfer-port
 * resolver.
 *
 * Every orchestration leaf (the controller, picking, and later recovery)
 * needs the same three facts: whether a live, authorized pane is open on the
 * current computer, whether that computer advertises `upload_file`, and how to
 * obtain the (production or test-injected) transfer port. Holding them here
 * keeps those gates identical everywhere and gives tests one seam to inject a
 * fake port.
 *
 * The controller re-exports the public surface (`currentAttachmentScope`,
 * `attachmentsAllowed`, `setAttachmentTransferPort`, `attachmentDisplayLimits`)
 * so existing module imports are unchanged. This module also wires the
 * extracted image-edit module's port loader, avoiding a controller↔edit cycle.
 */
import { currentDaemonId, currentHerdSession, liveSession } from "../../computers/catalog-store";
import { phase, connectionStore } from "../../connection/connection-store";
import { capabilityEnabled } from "../../operations/capabilities-store";
import { openPaneId } from "../session-store";
import { setAttachmentEditPortLoader } from "./attachments-edit";
import {
  FALLBACK_ATTACHMENT_LIMITS,
  type AnyLiveSession,
  type AttachmentScope,
  type AttachmentTransferPort,
} from "./attach-model";

/** Upload support comes from the computer's GetConfig capabilities. */
export function uploadFileEnabled(): boolean {
  return capabilityEnabled("upload_file");
}

export function currentAttachmentScope(): AttachmentScope | null {
  const paneId = openPaneId();
  if (phase() !== "live" || !paneId || !liveSession()) return null;
  const herdSession = currentHerdSession();
  return { daemonId: currentDaemonId(), paneId, ...(herdSession === null ? {} : { herdSession }) };
}

/** The attach affordance exists only with a live, authorized, capable session. */
export function attachmentsAllowed(): boolean {
  return currentAttachmentScope() !== null && uploadFileEnabled();
}

/**
 * The pane that opened the sheet is still the live, authorized pane. A mode
 * switch inside the same pane is allowed (captured by the caller's own
 * incarnation lock where insertion needs it).
 */
export function scopeMatches(scope: AttachmentScope): boolean {
  return phase() === "live"
    && openPaneId() === scope.paneId
    && currentDaemonId() === scope.daemonId
    && currentHerdSession() === (scope.herdSession ?? null)
    && liveSession() !== null;
}

/** Re-read every gate a queued job must hold before it may touch the wire. */
export function ownerStillValid(scope: AttachmentScope, session: AnyLiveSession): boolean {
  return scopeMatches(scope) && uploadFileEnabled() && liveSession() === session;
}

// --- Transfer port: production adapter loads lazily; tests inject a fake. ---------

let injectedPort: AttachmentTransferPort | null = null;
let cachedPort: AttachmentTransferPort | null = null;

export function setAttachmentTransferPort(port: AttachmentTransferPort | null): AttachmentTransferPort | null {
  injectedPort = port;
  return port;
}

/** Synchronous limits for capacity UI; canonical port numbers win after load. */
export function attachmentDisplayLimits() {
  return injectedPort?.limits ?? cachedPort?.limits ?? FALLBACK_ATTACHMENT_LIMITS;
}

export async function transferPort(): Promise<AttachmentTransferPort> {
  if (injectedPort) return injectedPort;
  if (!cachedPort) {
    const module = await import("./attachments-transfer");
    cachedPort = module.productionAttachmentTransfer;
  }
  return cachedPort;
}

// Wire the extracted image-edit module to this resolver so a test fake injected
// via setAttachmentTransferPort stays visible to editImage without
// attachments-edit back-importing any orchestration module (no cycle).
setAttachmentEditPortLoader(transferPort);

/** A user must explicitly restart queued work after direct connectivity returns. */
export class AttachmentP2PUnavailable extends Error {}

export function attachmentP2PReady(): boolean {
  const connection = connectionStore.get();
  const session = liveSession();
  return connection.sessionTransport === "p2p" && !connection.transportSwitching
    && !!session?.isConnected() && !session.isChecking?.();
}

export function requireAttachmentP2P(): void {
  if (!attachmentP2PReady()) throw new AttachmentP2PUnavailable("P2P connection required");
}
