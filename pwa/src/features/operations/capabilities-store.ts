import { NO_OPERATION_CAPABILITIES, type OperationCapabilities } from "../../lib/operations";
import { createDomain, detach } from "../../shared/model/domain-store";

/**
 * Capabilities domain: what the connected daemon allows, and whether a mutation
 * is in flight.
 *
 * `GetConfig.capabilities` is the authority for showing and allowing an
 * operation; an older daemon that does not advertise a key means false. Nothing
 * here invents aggregate aliases, and a dropped session fails closed to
 * `NO_OPERATION_CAPABILITIES` rather than keeping the last known grants.
 */
export type CapabilitiesRecord = {
  operationCapabilities: OperationCapabilities;
  agentKinds: string[];
  operationBusy: boolean;
};

const capabilitiesDomain = createDomain<CapabilitiesRecord>("capabilities", {
  operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
  agentKinds: [],
  operationBusy: false,
});
export const capabilitiesStore = capabilitiesDomain.store;
const { read, write } = capabilitiesDomain.controller;


/**
 * Adopt the advertised grants. The payload is detached, so a caller that keeps
 * the object it passed cannot change what this domain authorizes — and cannot
 * hitchhike on a later unrelated publish.
 */
export function applyCapabilities(capabilities: OperationCapabilities, agentKinds: readonly string[]): void {
  write((record) => {
    record.operationCapabilities = detach({ ...capabilities });
    record.agentKinds = detach([...agentKinds]);
  });
}

/** Fail closed: no advertised capability, no agent kinds. */
export function clearCapabilities(): void {
  write((record) => {
    record.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
    record.agentKinds = [];
  });
}

/** A reader-requested mutation is in flight; the shell shows one busy marker. */
export function operationBusy(): boolean {
  return read().operationBusy;
}

export function capabilityEnabled(key: keyof OperationCapabilities): boolean {
  return read().operationCapabilities[key] === true;
}

/**
 * Detached live grants. Action-time: a write is visible here immediately, not
 * only on the published snapshot. The caller cannot edit canonical grants.
 */
export function operationCapabilities(): OperationCapabilities {
  return detach(read().operationCapabilities);
}

/** Advertised agent kinds, detached so a caller cannot alias the domain record. */
export function advertisedAgentKinds(): readonly string[] {
  return [...read().agentKinds];
}

/** A mutation the reader asked for is in flight; the UI shows one busy marker. */
export function setOperationBusy(busy: boolean): void {
  if (read().operationBusy === busy) return;
  write((record) => {
    record.operationBusy = busy;
  });
}
