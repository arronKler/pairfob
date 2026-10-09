import { createContext, useContext, useEffect, useRef } from "react";

/**
 * What Escape undoes before the dialog itself.
 *
 * One rule in every dialog: Escape takes back the last thing the reader did.
 * A question asked in place (closing a session from its panel) or a list that
 * took the form's place (every agent, instead of the four tiles) is one step;
 * a page pushed into the dialog is the next; the dialog is the last. Without
 * this the key skipped straight to the page or the dialog and threw away the
 * step the reader meant to take back.
 *
 * A step is the key's alone. A close request that is not a key (a phone's
 * system back, the backdrop, the close control) still means the whole surface.
 */
export type EscapeSteps = {
  /** Note a step that is showing; the returned function forgets it. */
  add(undo: () => void): () => void;
  /** Undo the latest step still showing; false when there is none. */
  undo(): boolean;
};

export function createEscapeSteps(): EscapeSteps {
  const steps: Array<() => void> = [];
  return {
    add(undo) {
      steps.push(undo);
      return () => {
        const at = steps.lastIndexOf(undo);
        if (at !== -1) steps.splice(at, 1);
      };
    },
    undo() {
      const last = steps.at(-1);
      if (!last) return false;
      last();
      return true;
    },
  };
}

export const EscapeStepsContext = createContext<EscapeSteps | null>(null);

/**
 * While `showing`, Escape in the enclosing dialog calls `undo` and nothing
 * else. `undo` is read when the key arrives, so it may close over fresh state.
 */
export function useEscapeStep(showing: boolean, undo: () => void): void {
  const steps = useContext(EscapeStepsContext);
  const latest = useRef(undo);
  latest.current = undo;
  useEffect(() => {
    if (!showing || !steps) return;
    return steps.add(() => latest.current());
  }, [showing, steps]);
}
