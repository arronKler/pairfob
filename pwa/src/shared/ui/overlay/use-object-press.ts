import { useLayoutEffect, useRef } from "react";
import { bindObjectPress } from "./object-press";
import type { OverlayOrigin } from "./origin";

/** Keep the native press lifetime stable while its action receives fresh data. */
export function useObjectPress(open: (origin: OverlayOrigin) => void, enabled = true) {
  const element = useRef<HTMLButtonElement>(null);
  const action = useRef(open);
  useLayoutEffect(() => { action.current = open; });
  useLayoutEffect(() => {
    if (!enabled || !element.current) return;
    return bindObjectPress(element.current, origin => action.current(origin));
  }, [enabled]);
  return element;
}
