import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * One Tab stop for the lines of a diff.
 *
 * Every line that can take a note has a button, and a diff has hundreds of
 * lines: as Tab stops they would stand between the reader and everything after
 * the diff — the notes waiting to be sent, the next file. So the lines share a
 * stop, on the line the reader was last on, and the arrows, Home and End move
 * along them. A note's own controls stay ordinary stops under its line.
 */

const LINE = ".diff-comment-btn";

export function useLineStops(table: RefObject<HTMLElement | null>): {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
} {
  const stop = useRef<HTMLElement | null>(null);
  const lines = (): HTMLElement[] => [...(table.current?.querySelectorAll<HTMLElement>(LINE) ?? [])];
  const hold = (line: HTMLElement | null): void => {
    if (stop.current && stop.current !== line) stop.current.tabIndex = -1;
    if (line) line.tabIndex = 0;
    stop.current = line;
  };

  // After every render: lines come and go with the patch, and exactly one holds the stop.
  useLayoutEffect(() => {
    const all = lines();
    const kept = stop.current && all.includes(stop.current) ? stop.current : all[0] ?? null;
    for (const line of all) {
      const index = line === kept ? 0 : -1;
      if (line.tabIndex !== index) line.tabIndex = index;
    }
    stop.current = kept;
  });

  return {
    onFocus(event) {
      const line = event.target.matches(LINE) ? event.target : null;
      if (line) hold(line);
    },
    onKeyDown(event) {
      const line = event.target as HTMLElement;
      if (!line.matches(LINE) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const all = lines();
      const at = all.indexOf(line);
      const to = event.key === "ArrowDown" ? Math.min(at + 1, all.length - 1)
        : event.key === "ArrowUp" ? Math.max(at - 1, 0)
        : event.key === "Home" ? 0
        : event.key === "End" ? all.length - 1
        : -1;
      if (at < 0 || to < 0) return;
      // The arrows are the lines' while one has focus; without this they would scroll the diff as well.
      event.preventDefault();
      hold(all[to]);
      all[to].focus();
    },
  };
}
