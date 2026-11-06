import { topDialogBack, subscribeDialogBack } from "../shared/ui/overlay/back";
import { subscribeAppFrame } from "./frame";
import { bindBackHistory } from "./back-history";
import { parseNotificationURL } from "../lib/notification-target";
import { pageOrigin } from "../lib/runtime-config";
import { connectedPresentation, subscribePresentation } from "./presentation";

export function systemBackAction(): (() => void | Promise<void>) | null {
  return topDialogBack() ?? connectedPresentation()?.systemBackAction() ?? null;
}

/** A key, a press or a touch: what lets an added history entry survive the back UI. */
const GESTURES = ["pointerdown", "keydown", "touchstart"] as const;

function listensForGesture(gesture: () => void): () => void {
  for (const type of GESTURES) window.addEventListener(type, gesture, { capture: true, passive: true });
  return () => { for (const type of GESTURES) window.removeEventListener(type, gesture, { capture: true }); };
}

export function bindSystemBack(): () => void {
  const owner = bindBackHistory({
    state: () => history.state,
    replace: state => history.replaceState(state, ""),
    push: state => history.pushState(state, ""),
    back: () => history.back(),
    forward: () => history.forward(),
    listen(pop) { window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); },
    listenGesture: listensForGesture,
  }, systemBackAction, crypto.randomUUID());
  // Portal cleanup and frame publication can happen in the same React commit.
  // Reconcile after it, once the actual top surface is known.
  let alive = true;
  const sync = () => queueMicrotask(() => { if (alive) owner.sync(); });
  let stopFeatures = () => {};
  const bindFeatures = () => {
    stopFeatures();
    stopFeatures = connectedPresentation()?.subscribeBack(sync) ?? (() => {});
    sync();
  };
  const stops = [subscribeAppFrame(sync), subscribeDialogBack(sync), subscribePresentation(bindFeatures)];
  bindFeatures();
  const hash = (event: HashChangeEvent) => {
    // Notification capture scrubs the hash first. Use the event's original URL;
    // ordinary links and iframe history are not application navigation.
    if (parseNotificationURL(event.newURL, pageOrigin())) owner.consumeHashEntry();
  };
  window.addEventListener("hashchange", hash);
  return () => {
    alive = false;
    stopFeatures();
    for (const stop of stops) stop();
    window.removeEventListener("hashchange", hash);
    owner.dispose();
  };
}
