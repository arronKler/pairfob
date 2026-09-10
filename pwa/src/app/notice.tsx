import { useSyncExternalStore } from "react";
import { subscribeVisibleNotice, visibleNotice } from "./notices-store";
import { Feedback } from "../shared/ui/primitives";

/**
 * The App-owned application notice.
 *
 * Notice current-view authority lives here, not in a shared primitive or a
 * feature: this is the only component that subscribes to the notice domain's
 * visible-toast projection (`app/state/notices` owns scope, timeout and
 * publication). Screens render `<AppNotice/>` to place that one toast; generic
 * shared UI imports no App state.
 */

/** Subscribe to the scoped toast the current view should show. */
export function useAppNotice() {
  return useSyncExternalStore(subscribeVisibleNotice, visibleNotice);
}

/** The one application-wide toast; renders nothing when no notice is current. */
export function AppNotice() {
  const notice = useAppNotice();
  return notice ? <Feedback value={notice} appNotice /> : null;
}
