import { useLayoutEffect, useRef } from "react";
import { bindObjectPress } from "../press-menu";

/** Keep the native press lifetime stable while its action receives fresh data. */
export function useObjectPress(open: () => void, enabled = true) {
  const element = useRef<HTMLButtonElement>(null);
  const action = useRef(open);
  useLayoutEffect(() => { action.current = open; });
  useLayoutEffect(() => {
    if (!enabled || !element.current) return;
    return bindObjectPress(element.current, () => action.current());
  }, [enabled]);
  return element;
}
