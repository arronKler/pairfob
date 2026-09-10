import { flushSync } from "react-dom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { commitApp, lastCommittedLayoutKey, noteCommittedLayout, preparePublishedCommit, requestCommit,
  resetCommitState } from "./commit";
import { appRoot } from "./dom-root";
import { resetFrame, syncFrameLayout } from "./frame";
import { appHost, registerAppHost, releaseAppHost, type AppHost } from "./host";
import { followLayoutInputs, resetLayout } from "./layout-store";
import { applyShell, clearShell } from "./shell";
import { publishPendingDomains } from "./domain-publication";
import { flushNotifications, resumeNotifications, suspendNotifications } from "../shared/model/domain-store";

/**
 * The single application React root.
 *
 * `mountApp` creates it once and renders `<App/>`; from then on every application
 * update goes through domain publication and `commitApp`, never through another
 * page-level `root.render(screen)`. Shared modal portals (`lib/react-modal`) and
 * the pane-swipe underlay keep their own roots with bounded dispose; those are
 * adapters, not a second application. Do not add a global modal bus just to
 * shrink the lexical `createRoot` count. Their lifecycle still needs tests.
 *
 * The first mount follows the same ownership discipline as an ordinary commit —
 * publish, prepare, apply the shell, then render — so a child that measures in
 * its own layout effect already sees the shell it is inside.
 *
 * Mounting is a guarded transaction: if preparation throws, or a subscriber
 * cancels through the host while mounting, nothing is left half-owned.
 * `unmountApp` is idempotent while mounting, while mounted, and with no app at all.
 */
let root: Root | null = null;
let mounting = false;
let stopFollowingLayout: (() => void) | null = null;

const host: AppHost = {
  commit: (options) => commitApp(options),
  requestCommit: () => requestCommit(),
  unmount: () => unmountApp(),
};

export function isAppMounted(): boolean {
  return root !== null;
}

/** True while the first mount transaction is running. */
export function isMounting(): boolean {
  return mounting;
}

export function mountApp(): void {
  if (root || mounting) return;
  mounting = true;
  registerAppHost(host);
  try {
    stopFollowingLayout?.();
    stopFollowingLayout = followLayoutInputs((layout) => {
      // A new page needs the commit pipeline (session owner, scroll, frame).
      // Font/busy-only patches apply the shell first, then publish the frame.
      if (layout.key !== lastCommittedLayoutKey()) {
        requestCommit();
        return;
      }
      applyShell(layout);
      syncFrameLayout(layout);
    });
    // Publish, prepare, shell: the same guarded pipeline an ordinary commit uses,
    // so a nested preparer's writes cannot preempt this pass.
    const layout = preparePublishedCommit();
    noteCommittedLayout(layout.key);
    // A subscriber can cancel through the host during preparation or during the
    // initial notification; either way the mount stops and owns nothing.
    if (appHost() !== host) return;
    flushNotifications();
    if (appHost() !== host) return;

    const container = appRoot();
    const mounted = createRoot(container);
    root = mounted;
    // One synchronous mount: the caller that mounts is a navigation or a fixture
    // that measures the arriving page immediately afterwards.
    flushSync(() => {
      mounted.render(createElement(App));
    });
    if (appHost() !== host) {
      // Cancelled while the first tree rendered: do not leave a second owner.
      if (root === mounted) {
        root = null;
        mounted.unmount();
        releaseOwnedState();
      }
    }
  } catch (error) {
    // A failed mount must not leave a host, a frame or a shell behind: nothing
    // would ever reclaim them, and domain actions would target a rootless app.
    const mounted = root;
    root = null;
    try {
      mounted?.unmount();
    } catch {
      /* already unmounted by a reentrant unmountApp */
    }
    releaseAppHost(host);
    stopFollowingLayout?.();
    stopFollowingLayout = null;
    releaseOwnedState();
    throw error;
  } finally {
    mounting = false;
  }
}

/** Idempotent teardown: safe while mounting, while mounted, and with no app. */
export function unmountApp(): void {
  const mounted = root;
  root = null;
  releaseAppHost(host);
  stopFollowingLayout?.();
  stopFollowingLayout = null;
  try {
    mounted?.unmount();
  } catch {
    /* already unmounted */
  }
  releaseOwnedState();
}

function releaseOwnedState(): void {
  // One unobservable retirement. Every cleanup step below publishes — any
  // staged composition, the frame, the layout — so the retiring lifetime
  // finishes all of its owned cleanup before any of those publications can
  // notify a subscriber. A subscriber that mounts a replacement on the null
  // frame/layout therefore observes a fully retired lifetime, and the old
  // cleanup can never clear state the replacement owns. Writes stay immediate
  // for readers; only their notifications defer to the single final flush.
  suspendNotifications();
  try {
    // Host is gone: publish any staged composition so later headless writes
    // are not stranded.
    publishPendingDomains();
    resetFrame();
    resetLayout();
    clearShell();
    resetCommitState();
  } finally {
    resumeNotifications();
    flushNotifications();
  }
}
