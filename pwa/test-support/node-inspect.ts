import { Node } from "happy-dom";
import { describeNode } from "./node-identity";

/**
 * Makes a failing matcher print a DOM node as one line.
 *
 * Bun reports a failed `expect` by printing the values involved, and a
 * happy-dom node prints as everything it can reach: document, window, the
 * React fibres hung on it. One node is hundreds of megabytes and ten seconds
 * and more (`toBeNull()` on an element that should have gone); two are more
 * than Bun can put in a string, and then the matcher does not throw at all
 * (`toBe` between two different elements). See `node-identity.ts`.
 *
 * Every window's node classes extend this one, so one description on its
 * prototype covers every realm a test builds. `bunfig.toml` preloads this for
 * `bun test`; the shared DOM installers import it too, for a run started
 * outside `pwa/`.
 */
Object.defineProperty(Node.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  configurable: true,
  writable: true,
  value(this: Node): string {
    return `<${describeNode(this)}>`;
  },
});
