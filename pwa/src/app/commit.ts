import { flushSync } from "react-dom";
import { syncFrameLayout } from "./frame";
import { prepareFrame } from "./frame-prepare";
import type { CommitOptions } from "./host";
import { refreshLayout } from "./layout-store";
import { applyShell, type ShellLayout } from "./shell";
import { publishPendingDomains } from "./domain-publication";
import {
  beginPublicationTransaction, endPublicationTransaction, flushNotifications, resumeNotifications,
  suspendNotifications,
} from "../shared/model/domain-store";
import { takeTransition, withSynchronousTransition } from "./transition";

/**
 * The commit pipeline: the only place the application renders.
 *
 * One commit is one transaction. Domain writes made through the compatibility
 * facade are published, the frame for the new composition is prepared (including
 * the imperative work a page needs before React renders it), writes the
 * preparation itself made are published, the shell is applied, and only then are
 * subscribers notified — so React renders once with coherent data, and `<App/>`
 * never has to be re-rendered by a caller.
 *
 * Synchronous flushing is narrow by design. A declared navigation or a change of
 * composition commits synchronously because the arriving page is measured,
 * scrolled and focused right after the paint. The declared transition for that
 * synchronous path is the arrival-only CSS fallback (shared with the ordinary
 * adapter), never a native ViewTransition: native capture defers its update
 * callback, which the synchronous controller boundary does not promise. An
 * ordinary update — a poll, an echo, a settings value — lets React schedule the
 * render.
 *
 * Re-entrancy is bounded. A preparer inside the preparation asks for a commit;
 * that request joins the commit in flight. A page that writes from inside its
 * own render or effect asks for one more commit after the notifications, up to a
 * small budget, so a repaint can never become a loop.
 */
const RECOMMIT_BUDGET = 4;

let committing = false;
let notifying = false;
let recommit = false;
let recommitUsed = 0;
let scheduled = false;
let scheduledToken = 0;
let lastLayoutKey = "";

/**
 * Ask for a commit without forcing one. Domain actions that change the
 * composition call this so a migrated caller does not have to paint by hand; the
 * request is coalesced, and an explicit commit before the microtask cancels it.
 */
export function requestCommit(): void {
  if (committing || notifying) {
    // Asked from inside a commit: the pipeline runs one more bounded pass instead
    // of dropping the request or recursing.
    recommit = true;
    return;
  }
  if (scheduled) return;
  scheduled = true;
  const token = ++scheduledToken;
  queueMicrotask(() => {
    // An explicit commit already happened: this request is spent.
    if (token !== scheduledToken) return;
    scheduled = false;
    commitApp();
  });
}

/**
 * Publish pending writes, prepare the frame, publish preparation writes, apply
 * the shell. Nested commits join this pass instead of preparing again.
 */
export function preparePublishedCommit(): ShellLayout {
  committing = true;
  try {
    suspendNotifications();
    beginPublicationTransaction();
    try {
      // Publish what callers wrote, prepare the view, then publish what the
      // preparation itself wrote. A preparer that stages another pane or screen
      // joins this same pass: observers never see the pre-callback binding.
      let layout = refreshLayout();
      for (let pass = 0; ; pass += 1) {
        publishPendingDomains();
        prepareFrame();
        publishPendingDomains();
        layout = refreshLayout();
        applyShell(layout);
        // Preparation-induced ordinary writes (font, busy) must land on the
        // prepared frame before any observer runs; do not wait for a later
        // follower pass that may see no layout-store change.
        syncFrameLayout(layout);
        if (!recommit) break;
        recommit = false;
        if (pass >= RECOMMIT_BUDGET) break;
      }
      return layout;
    } finally {
      endPublicationTransaction();
      resumeNotifications();
    }
  } finally {
    committing = false;
  }
}

export function commitApp(options: CommitOptions = {}): void {
  // Cancel a coalesced request: this commit is the one it asked for.
  scheduled = false;
  scheduledToken += 1;
  if (committing) return;
  if (notifying) {
    recommit = true;
    return;
  }

  const previousKey = lastLayoutKey;
  const layout = preparePublishedCommit();
  const navigation = layout.key !== previousKey;
  lastLayoutKey = layout.key;

  notifying = true;
  try {
    // A navigation is the only commit that consumes a declared view transition,
    // and it consumes it exactly once: a legacy explicit paint already took the
    // declared kind, a typed navigation's coalesced commit takes it here, and a
    // bounded recommit pass runs against the same key and takes nothing.
    const kind = navigation ? takeTransition() : "none";
    if (kind !== "none") {
      // Synchronous controller path (commitView / navigation): run the arriving
      // composition through the arrival-only CSS fallback entry with the real
      // DOM update as its paint, so the boundary returns with the DOM present.
      // A native startViewTransition is never started here — its update callback
      // is deferred, so old-to-new native capture is not promised by commitView.
      withSynchronousTransition(kind, () => flushSync(() => flushNotifications()));
    } else if (options.sync ?? navigation) {
      flushSync(() => flushNotifications());
    } else {
      flushNotifications();
    }
  } finally {
    notifying = false;
  }

  if (!recommit) {
    recommitUsed = 0;
    return;
  }
  recommit = false;
  if (recommitUsed >= RECOMMIT_BUDGET) {
    // Something paints on every render. Stop instead of spinning; the next real
    // commit still shows the current state.
    recommitUsed = 0;
    return;
  }
  recommitUsed += 1;
  commitApp(options);
}

/** True while a commit is running; a nested paint joins it. */
export function isCommitting(): boolean {
  return committing || notifying;
}

/** The composition key the last commit rendered. */
export function lastCommittedLayoutKey(): string {
  return lastLayoutKey;
}

/** Record the composition the current mount/commit already applied. */
export function noteCommittedLayout(key: string): void {
  lastLayoutKey = key;
}

/** Forget the committed composition and any pending request (unmount, fixtures). */
export function resetCommitState(): void {
  lastLayoutKey = "";
  scheduled = false;
  scheduledToken += 1;
  recommit = false;
  recommitUsed = 0;
}
