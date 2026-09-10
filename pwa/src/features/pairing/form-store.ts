import type { PairErrorField, PairStepKey } from "../../lib/ui-model";
import { createDomain } from "../../shared/model/domain-store";

/**
 * Pairing domain: the add-computer handshake input and its failure rail.
 * Credentials and the computer list live in `computers.ts`; the origin/pairing
 * intent fragment lives in `connection.ts`.
 */
export type PairingRecord = {
  pairCodeDraft: string;
  pairManualOpen: boolean;
  pairErrorTarget: PairErrorField;
  /** Which of the three pairing steps the last attempt died on, for the rail. */
  pairFailedStep: PairStepKey | null;
  pairAwaitingApproval: boolean;
  pairAbort: AbortController | null;
};

/** `pairAbort` is an opaque handle: a controller is a live resource, not data. */
const pairingDomain = createDomain<PairingRecord, "pairAbort">("pairing", {
  pairCodeDraft: "",
  pairManualOpen: false,
  pairErrorTarget: null,
  pairFailedStep: null,
  pairAwaitingApproval: false,
  pairAbort: null,
}, { opaque: ["pairAbort"] });
export const pairingStore = pairingDomain.store;
const { read, write } = pairingDomain.controller;


export function setPairCodeDraft(code: string): void {
  if (read().pairCodeDraft === code) return;
  write((record) => {
    record.pairCodeDraft = code;
  });
}

export function setPairManualOpen(open: boolean): void {
  if (read().pairManualOpen === open) return;
  write((record) => {
    record.pairManualOpen = open;
  });
}

/** Mark the field and step a failed attempt died on, or clear both on success. */
export function setPairFailure(target: PairErrorField, step: PairStepKey | null): void {
  write((record) => {
    record.pairErrorTarget = target;
    record.pairFailedStep = step;
  });
}

export function setPairAwaitingApproval(awaiting: boolean): void {
  if (read().pairAwaitingApproval === awaiting) return;
  write((record) => {
    record.pairAwaitingApproval = awaiting;
  });
}

export function setPairAbort(controller: AbortController | null): void {
  write((record) => {
    record.pairAbort = controller;
  });
}

/**
 * Action-time readers for the pairing record. The abort handle is an opaque
 * live resource and is returned by identity; the rest are plain values read
 * from the coherent live record without a facade alias.
 */
export function pairAbortHandle(): AbortController | null {
  return read().pairAbort;
}

export function pairCodeDraft(): string {
  return read().pairCodeDraft;
}

export function pairManualOpen(): boolean {
  return read().pairManualOpen;
}

export function pairErrorTarget(): PairErrorField {
  return read().pairErrorTarget;
}

export function pairFailedStep(): PairStepKey | null {
  return read().pairFailedStep;
}

export function pairAwaitingApproval(): boolean {
  return read().pairAwaitingApproval;
}

/** Clear only the error field; the failure-step rail keeps its last step. */
export function clearPairErrorTarget(): void {
  if (read().pairErrorTarget === null) return;
  write((record) => {
    record.pairErrorTarget = null;
  });
}

/** Clear the handshake input when a pairing attempt ends or the screen closes. */
export function resetPairingInput(): void {
  write((record) => {
    record.pairCodeDraft = "";
    record.pairManualOpen = false;
    record.pairErrorTarget = null;
    record.pairFailedStep = null;
    record.pairAwaitingApproval = false;
    record.pairAbort = null;
  });
}
