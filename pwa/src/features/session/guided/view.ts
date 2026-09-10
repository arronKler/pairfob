import { currentScreen } from "../../../app/navigation-store";
import { batch } from "../../../app/domain-publication";
import { compositionPublicationHeld } from "../../../shared/model/domain-store";
import { getAppFrame } from "../../../app/frame";
import { liveSession } from "../../computers/catalog-store";
import { currentViewIncarnation } from "../drafts/state-drafts";
import { composeFocused } from "../compose-store";
import { applyPaneRead, isAgentChat, livePaneHash, livePaneText, openPaneId, sessionStore, setPaneFollow, setPaneUnread, termSelect } from "../session-store";
import { registerSessionView } from "../register";
import { appRoot } from "../../../app/dom-root";
import { isDesk } from "../../../app/viewport";
import { composeField, sizeCompose, syncSendButton } from "./compose";
import { settleEcho } from "./echo";
import { paneModel } from "./pane-model";
import { discardEmptyPaneRow } from "./rowbar";
import {
  atBottom,
  displayedTermModel,
  restoreTermScroll,
  sessionScroll,
  stickBottom,
  syncJump,
  termElement,
} from "./term";
import { markCaughtUp, noteSnapshot, unreadCount } from "./unread";
import { flushSync } from "react-dom";

import { notifySessionUI } from "./ui-revision";

export type SessionHandlers = {
  onBack: () => void;
  onMenu: () => void;
  onSwitch: () => void;
  onWorkspace: () => void;
};

/** Outcome of an in-place terminal patch. */
export type SessionPatchOutcome = "patched" | "deferred" | "missing";

// The committed pane/session/incarnation this patch renders against, from the
// published prepared frame, AND the actual canonical owner/live handle. A
// reentrant staged publication or a no-hold ordinary write (e.g. a replacement
// live handle via attachLiveSession) can change either; recheck the full bound
// before any model/DOM side-effect.
type CommitBound = { paneId: string; session: unknown; incarnation: number };

// The frame pane/session/incarnation must match the canonical owner/live handles
// (openPaneId / liveSession / currentViewIncarnation). attachLiveSession replaces
// the live handle with no composition hold, so a stale entry frame must not be
// accepted against an already-replaced owner.
function frameOwnsCanonicalOwner(): boolean {
  const s = getAppFrame().session;
  if (!s) return false;
  return s.paneId === openPaneId()
    && s.incarnation === currentViewIncarnation()
    && getAppFrame().sessionOwner === liveSession();
}

function committedBound(): CommitBound | null {
  const s = getAppFrame().session;
  if (!s) return null;
  return { paneId: s.paneId, session: getAppFrame().sessionOwner, incarnation: s.incarnation };
}

// Still on the same committed owner AND the same DOM node, with no pending
// composition hold. Call after any synchronous named publication that can let a
// subscriber commit a replacement (e.g. applyPaneRead, batch(follow/unread)).
function stillBound(bound: CommitBound, term: HTMLElement | null): boolean {
  if (compositionPublicationHeld()) return false;
  const s = getAppFrame().session;
  if (!s || s.paneId !== bound.paneId || s.incarnation !== bound.incarnation) return false;
  if (getAppFrame().sessionOwner !== bound.session) return false;
  if (!frameOwnsCanonicalOwner()) return false;
  return term === null || termElement() === term;
}

export function finishSessionPaint(scroll: { top: number; left: number; bottom: boolean }, input?: HTMLTextAreaElement): void {
  if (isAgentChat()) return;
  const term = termElement();
  if (term) {
    restoreTermScroll(term, scroll);
    setPaneFollow(scroll.bottom);
    if (scroll.bottom) markCaughtUp(openPaneId(), paneModel().texts);
    syncJump();
  }
  const field = input ?? composeField();
  if (field) {
    sizeCompose(field);
    if (composeFocused() || isDesk()) {
      field.focus({ preventScroll: true });
      const caret = field.value.length;
      field.setSelectionRange(caret, caret);
    }
  }
}

export function patchChromeTitle(): void {
  // A pending staged composition or a live-owner that no longer matches the
  // committed frame means the arriving owner/frame is not prepared yet; the
  // already-queued App commit re-renders SessionPane on arrival. Skip the
  // old-DOM leaf revision instead of notifying against stale chrome.
  if (compositionPublicationHeld()) return;
  if (!frameOwnsCanonicalOwner()) return;
  if (appRoot().querySelector("[data-react-session-chrome]")) {
    flushSync(notifySessionUI);
  }
}

/** In-place buffer update that keeps scroll, selection and a typed draft. */
export function patchSessionScreen(): SessionPatchOutcome {
  // A pending staged composition (session/pane/page/phase) has its own arriving
  // owner/frame/shell. Leaf patching would split it and read a stale snapshot
  // (applyPaneRead cannot publish under the hold). Defer to the queued App
  // commit; this is a real outcome, not "no terminal".
  if (compositionPublicationHeld()) return "deferred";

  const term = termElement();
  const extras = appRoot().querySelector(".session-extras") as HTMLElement | null;
  if (!term || !extras || currentScreen() !== "pane") return "missing";
  // The committed frame must own the canonical owner/live handle before ANY
  // measurement, so a no-hold replaced live handle is never accepted.
  const bound = committedBound();
  if (bound === null || !frameOwnsCanonicalOwner()) return "missing";
  // Repainting rows would collapse an in-progress text selection.
  if (termSelect()) return "patched";
  const following = atBottom(term);
  const left = term.scrollLeft;
  const top = term.scrollTop;
  // Publish the live pane read before any snapshot-backed model or echo work.
  // A notified subscriber may synchronously commit a replacement (no hold), so
  // recheck the bound + node identity before reading the snapshot model.
  applyPaneRead(livePaneText(), livePaneHash());
  if (!stillBound(bound, term)) return "deferred";
  const session = sessionStore.get();
  const model = paneModel();
  // The snapshot is the truth: resolve the prediction before drawing it.
  settleEcho(bound.paneId, model.texts, session.paneHash);
  if (!stillBound(bound, term)) return "deferred";
  discardEmptyPaneRow(displayedTermModel(model));
  if (!stillBound(bound, term)) return "deferred";
  // Count new output before publishing unread, so the chip sees the same turn.
  noteSnapshot(bound.paneId, model.texts, following);
  batch(() => {
    setPaneFollow(following);
    setPaneUnread(unreadCount() > 0);
  });
  if (!stillBound(bound, term)) return "deferred";
  // syncSendButton can notify subscribeComposeView, whose subscriber may stage a
  // fresh composition; recheck the bound BEFORE notifySessionUI so the revision
  // is not bumped against a held stale frame, then defer.
  flushSync(() => {
    syncSendButton();
    if (stillBound(bound, term)) notifySessionUI();
  });
  // The revision subscriber may have replaced the composition synchronously;
  // do not scroll/focus the old DOM on that arriving owner.
  if (!stillBound(bound, term)) return "deferred";
  restoreTermScroll(term, { left, top, bottom: following });
  syncJump();
  return "patched";
}

export { sessionScroll, stickBottom };

/** Normalize controller state before rendering; JSX only reads the prepared view. */
export function prepareSessionPaint(): ReturnType<typeof sessionScroll> {
  registerSessionView();
  applyPaneRead(livePaneText(), livePaneHash());
  discardEmptyPaneRow(displayedTermModel(paneModel()));
  return sessionScroll();
}