import { t } from "../../lib/i18n";
import { normalizeCrockford } from "../../lib/protocol/bytes";
import type { PairStepKey } from "../../lib/ui-model";
import { parseCodeAndLocator, type FragmentPairing } from "../../lib/pairing-input";

export type ConnectNotice = { text: string; tone: "error" | "status" };

/**
 * Pure projection for the connect/pairing screen. The caller supplies the
 * handshake input, connection phase and notice; this file does not read state.
 *
 * One skeleton for every stage: top bar, terminal miniature, title + lede and
 * the bottom actions. A stage only swaps copy and the miniature's lines.
 *
 * Two independent facts shape the page. Width picks the layout: one column, or
 * two. The pointer picks the way in: a camera scans the QR on the other screen,
 * while a mouse sits at the screen the QR would be on, so there the code is
 * typed and no scan is offered, in a narrow window as much as in a wide one.
 */

export type ConnectStage = "idle" | "connecting" | "approve" | "failed";
/** One column (a phone, a tablet in portrait, a narrow window) or two. */
export type ConnectLayout = "phone" | "wide";
/** What the reader does first: scan with this device's camera, or type the code. */
export type ConnectEntry = "scan" | "code";

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
  /** Room for two columns. */
  wide: boolean;
  /** The primary pointer is a mouse or trackpad. */
  finePointer: boolean;
};

export type ConnectViewModel = {
  adding: boolean;
  busy: boolean;
  stage: ConnectStage;
  layout: ConnectLayout;
  entry: ConnectEntry;
  backTitle: string;
  title: string;
  lede: string;
  ledeTone: "muted" | "error" | "status";
  /** The lede carries a `{key}` slot for the Enter keycap. */
  ledeKeycap: boolean;
  showInstall: boolean;
  sheetOpen: boolean;
  /** The notice shown at the code field (in the sheet, or the card) instead of on the page. */
  fieldNotice: ConnectNotice | null;
  pairCodeDraft: string;
  pairCodeLength: number;
  pairCodeComplete: boolean;
  /** More code characters than a code has; the field says so at once (`fieldNotice`). */
  pairCodeOver: boolean;
  pairCodeInvalid: boolean;
};

/**
 * Group an explicitly pasted code as the computer prints it (4-4-6). Live
 * typing stays verbatim so formatting cannot interrupt the input method.
 * Anything that is not plain code characters is left for the submit parser,
 * and characters past the fourteenth stay in the last group: grouping never
 * drops what it was given.
 */
export function formatPairCodeDraft(raw: string): string {
  if (!/^[0-9A-Za-z \-]*$/.test(raw)) return raw;
  const code = normalizeCrockford(raw);
  if (code.length > 8) return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  if (code.length > 4) return `${code.slice(0, 4)}-${code.slice(4)}`;
  return code;
}

/** The characters of a typed code, as the field counts them. */
const PAIR_CODE_LENGTH = 14;

/**
 * How many code characters an entry holds: its letters and digits. What groups
 * them (a hyphen, a space) and anything else that came along (a dot, a pasted
 * quote mark) is not a character of the code, so it is neither counted against
 * the fourteen nor reported to the reader as one.
 */
export function pairCodeCount(rawCode: string): number {
  return rawCode.replace(/[^0-9A-Za-z]/g, "").length;
}

/**
 * Why a typed code was turned away before anything was sent, said as something
 * the reader can check against the computer's screen: nothing typed, too few
 * characters, too many, or the right number that still is not a code.
 */
export function pairCodeProblem(rawCode: string): string {
  const length = pairCodeCount(rawCode);
  if (!length) return t("err.locator_required");
  if (length < PAIR_CODE_LENGTH) return t("err.pairIncomplete", { n: length });
  if (length > PAIR_CODE_LENGTH) return t("err.pairTooLong", { n: length });
  return t("err.invalid_pair_code");
}

/** The code as the computer prints it (4-4-6), standing alone inside other text. */
const PRINTED_CODE = /(?:^|[^0-9A-Za-z-])([0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{6})(?![0-9A-Za-z-])/g;

/**
 * The one complete code in pasted text, grouped as the field shows it. Selecting
 * a terminal line drags its words and line break along, which the short field
 * would cut off mid-sentence. Anything else is left to the field's own paste.
 */
export function pastedPairCode(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const printed = [...flat.matchAll(PRINTED_CODE)].map(match => match[1]);
  const both = parseCodeAndLocator(printed.length === 1 ? printed[0] : flat);
  return both ? formatPairCodeDraft(both.code + both.loc) : null;
}

function stageOf(input: ConnectViewInput): ConnectStage {
  if (input.phase === "pairing") return input.pairAwaitingApproval ? "approve" : "connecting";
  return input.pairFailedStep && input.pairFailedStep !== "code" ? "failed" : "idle";
}

export function connectViewModel(input: ConnectViewInput): ConnectViewModel {
  const stage = stageOf(input);
  const busy = stage === "connecting" || stage === "approve";
  const adding = input.addingComputer || input.computerCount > 0;
  const layout: ConnectLayout = input.wide ? "wide" : "phone";
  // The pointer alone: a mouse in a narrow window still has no camera to aim
  // at its own screen, and a finger keeps the scan at any width.
  const entry: ConnectEntry = input.finePointer ? "code" : "scan";
  // The typed-code field is part of the page when typing is the way in; it is a
  // sheet over the page otherwise.
  const sheetOpen = entry === "scan" && !busy && input.pairManualOpen;
  const length = pairCodeCount(input.pairCodeDraft);
  // Too many characters is said while they are typed or pasted: the field keeps
  // every one of them, and the reader is not left to find out on Connect which
  // ones a shorter field would have dropped.
  const over = length > PAIR_CODE_LENGTH && !busy;
  const codeError = input.pairErrorTarget === "code";
  // A code error belongs to the field; the page never repeats it.
  const pageNotice = sheetOpen || codeError ? null : input.notice;
  let title = t("connect.title");
  // The typed lede says where the field is: beside the steps, or under them.
  let lede = entry === "code" ? t(layout === "wide" ? "connect.ledeDesk" : "connect.ledeTyped")
    : layout === "wide" ? t("connect.ledeWideScan") : t("connect.ledeIdle");
  let ledeTone: ConnectViewModel["ledeTone"] = "muted";
  let showInstall = true;
  if (stage === "connecting") {
    title = t("connect.connectingTitle");
    lede = input.fragment ? t("connect.ledeScanned") : t("connect.connectingLede");
    showInstall = false;
  } else if (stage === "approve") {
    title = t("connect.approveTitle");
    lede = t("connect.approveLede");
    showInstall = false;
  } else if (stage === "failed") {
    title = t("connect.failedTitle");
    lede = pageNotice?.tone === "error" ? pageNotice.text : t(entry === "code" ? "connect.failedLedeCode" : "connect.failedLede");
    ledeTone = "error";
    showInstall = false;
  } else if (pageNotice) {
    lede = pageNotice.text;
    ledeTone = pageNotice.tone === "error" ? "error" : "status";
    showInstall = false;
  }
  return {
    adding,
    busy,
    stage,
    layout,
    entry,
    backTitle: t("settings.addComputer"),
    title,
    lede,
    ledeTone,
    ledeKeycap: stage === "approve",
    showInstall,
    sheetOpen,
    fieldNotice: over ? { text: pairCodeProblem(input.pairCodeDraft), tone: "error" }
      : sheetOpen || (entry === "code" && codeError) ? input.notice : null,
    pairCodeDraft: input.pairCodeDraft,
    pairCodeLength: length,
    pairCodeComplete: length === PAIR_CODE_LENGTH,
    pairCodeOver: over,
    pairCodeInvalid: codeError || over,
  };
}
