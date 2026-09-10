import { t } from "../../lib/i18n";
import { normalizeCrockford } from "../../lib/protocol/bytes";
import { pairProgress, type PairStep, type PairStepKey } from "../../lib/ui-model";
import type { FragmentPairing } from "../../lib/pairing-input";

export type ConnectNotice = { text: string; tone: "error" | "status" };

/**
 * Pure projection for the connect/pairing screen. The caller supplies the
 * handshake input, connection phase and notice; this file does not read state.
 */

export type ConnectViewInput = {
  phase: string;
  addingComputer: boolean;
  computerCount: number;
  fragment: FragmentPairing | null;
  pairCodeDraft: string;
  pairManualOpen: boolean;
  pairErrorTarget: "code" | null;
  pairFailedStep: PairStepKey | null;
  pairAwaitingApproval: boolean;
  notice: ConnectNotice | null;
  desk: boolean;
};

export type ConnectViewModel = {
  pageClass: string;
  adding: boolean;
  busy: boolean;
  scanned: boolean;
  addingComputer: boolean;
  backTitle: string;
  title: string | null;
  lede: string;
  deskHint: string | null;
  qrNote: string | null;
  showGlobalNotice: boolean;
  waitTitle: string;
  waitCopy: string;
  rail: PairStep[];
  railNote: string | null;
  showFailedRail: boolean;
  pairCodeDraft: string;
  pairCodeLength: number;
  pairCodeComplete: boolean;
  pairCodeInvalid: boolean;
  manualOpen: boolean;
};

export function connectViewModel(input: ConnectViewInput): ConnectViewModel {
  const busy = input.phase === "pairing";
  const scanned = input.fragment !== null;
  const adding = input.addingComputer || input.computerCount > 0;
  const manualOpen = input.pairManualOpen || input.pairErrorTarget === "code";
  const railFailure = input.pairFailedStep && input.pairFailedStep !== "code" ? input.notice : null;
  const railNote = railFailure?.tone === "error" ? railFailure.text : null;
  const length = normalizeCrockford(input.pairCodeDraft).length;
  return {
    pageClass: adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`,
    adding,
    busy,
    scanned,
    addingComputer: input.addingComputer,
    backTitle: input.addingComputer ? t("settings.addComputer") : t("connect.pair"),
    title: adding ? null : t("connect.title"),
    lede: scanned ? t("connect.ledeScanned") : input.addingComputer ? t("connect.ledeAdd") : t("connect.ledeScan"),
    deskHint: input.desk && !adding && !scanned && !busy ? t("connect.deskHint") : null,
    qrNote: scanned ? t("connect.qrNote") : null,
    showGlobalNotice: !input.pairErrorTarget && !railNote && !!input.notice,
    waitTitle: input.pairAwaitingApproval ? t("connect.waitEnter") : t("connect.waitTitle"),
    waitCopy: input.pairAwaitingApproval ? t("connect.waitEnterCopy") : t("connect.waitCopy"),
    rail: pairProgress({
      pairing: busy,
      awaitingApproval: input.pairAwaitingApproval,
      failedStep: input.pairFailedStep,
    }),
    railNote,
    showFailedRail: !!input.pairFailedStep,
    pairCodeDraft: input.pairCodeDraft,
    pairCodeLength: length,
    pairCodeComplete: length === 14,
    pairCodeInvalid: input.pairErrorTarget === "code",
    manualOpen,
  };
}
