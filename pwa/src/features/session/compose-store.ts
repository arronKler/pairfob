import { createDomain } from "../../shared/model/domain-store";
import { defaultComposeLive, paneComposeLive } from "../settings/preferences-store";

/**
 * Compose domain: the input field of the open pane. Draft text, focus, IME
 * composition, and whether keystrokes go straight to the PTY.
 *
 * The persisted per-pane live/compose choice and the bounded draft store belong
 * to `preferences.ts` and `state-drafts.ts`; this domain owns what the field on
 * screen is doing right now.
 */
export const COMPOSE_MIN_PX = 46;
export const COMPOSE_MAX_PX = 136;

export type ComposeRecord = {
  composeDraft: string;
  composeFocused: boolean;
  composeIME: boolean;
  /** When true, keystrokes go to the PTY immediately instead of waiting for 发送. */
  composeLive: boolean;
};

/**
 * Pure defaults: the stored live/batch choice arrives with the boot hydration
 * (`adoptDefaultComposeLive`), not at import time.
 */
const composeDomain = createDomain<ComposeRecord>("compose", {
  composeDraft: "",
  composeFocused: false,
  composeIME: false,
  composeLive: false,
});
export const composeStore = composeDomain.store;
const { read, write, writeIf, stage } = composeDomain.controller;


export function setComposeDraft(text: string): void {
  if (read().composeDraft === text) return;
  write((record) => {
    record.composeDraft = text;
  });
}

export function setComposeFocused(focused: boolean): void {
  if (read().composeFocused === focused) return;
  write((record) => {
    record.composeFocused = focused;
  });
}

/** An IME composition owns the field: keys must not reach the PTY mid-composition. */
export function setComposeIME(composing: boolean): void {
  if (read().composeIME === composing) return;
  write((record) => {
    record.composeIME = composing;
  });
}

/** End IME and commit the fitted field in one write so subscribers see both. */
export function finishComposeComposition(text: string): void {
  writeIf((record) => {
    if (!record.composeIME && record.composeDraft === text) return false;
    record.composeIME = false;
    record.composeDraft = text;
    return true;
  });
}

export function setComposeLive(live: boolean): void {
  if (read().composeLive === live) return;
  write((record) => {
    record.composeLive = live;
  });
}

/** Adopt the stored choice for a pane when it opens. */
export function adoptPaneCompose(paneId: string): void {
  setComposeLive(paneComposeLive(paneId));
}

/** Boot hydration: the field follows the reader's stored default. */
export function adoptDefaultComposeLive(): void {
  setComposeLive(defaultComposeLive());
}

/** Clear the field when the pane view is retired. */
export function resetComposeField(): void {
  write((record) => {
    record.composeDraft = "";
    record.composeFocused = false;
    record.composeIME = false;
  });
}

/** Staged form so a pane-view reset can publish compose with the new session page. */
export function stageResetComposeField(): void {
  stage((record) => {
    record.composeDraft = "";
    record.composeFocused = false;
    record.composeIME = false;
  });
}

export function composeLive(): boolean {
  return read().composeLive;
}

export function composeDraft(): string {
  return read().composeDraft;
}

export function composeFocused(): boolean {
  return read().composeFocused;
}

export function composeIME(): boolean {
  return read().composeIME;
}
