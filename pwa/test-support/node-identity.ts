import { expect } from "bun:test";

/**
 * Identity assertions for DOM nodes.
 *
 * `expect(node).toBe(other)` is not safe on a happy-dom node. To report a
 * mismatch Bun prints both values, and a node reaches its document, its window
 * and, once React has rendered into it, the fibre tree: hundreds of megabytes
 * a node. Two of them pass the longest string Bun can build, the matcher then
 * returns without throwing, and the test passes after some twenty seconds.
 * `toEqual` walks the same graph to compare and does not come back at all.
 *
 * `node-inspect.ts` shortens what a node prints as, which makes every matcher
 * honest again wherever it is loaded. These compare with `===` and need
 * nothing loaded: use them whenever the question is "is this the same node".
 */

type NodeLike = { readonly nodeType: number; readonly nodeName: string };

function isNode(value: unknown): value is NodeLike {
  return typeof value === "object" && value !== null
    && typeof (value as NodeLike).nodeType === "number" && typeof (value as NodeLike).nodeName === "string";
}

const clip = (text: string, max = 32): string => text.length > max ? `${text.slice(0, max)}…` : text;

/** `button#save.btn.primary[aria-label="Save"]`: enough to tell which node it was, on one line. */
export function describeNode(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (!isNode(value)) return `${Object.prototype.toString.call(value)} (not a node)`;
  const node = value as NodeLike & {
    id?: unknown; isConnected?: boolean; nodeValue?: string | null;
    classList?: Iterable<string>; getAttribute?: (name: string) => string | null;
  };
  const detached = node.isConnected === false ? " (detached)" : "";
  // 3 text, 8 comment: named by what they hold.
  if (node.nodeType === 3 || node.nodeType === 8) return `${node.nodeName} ${JSON.stringify(clip(node.nodeValue ?? ""))}${detached}`;
  // 1 element. Documents and fragments have a name and nothing else worth printing.
  if (node.nodeType !== 1 || typeof node.getAttribute !== "function") return `${node.nodeName}${detached}`;
  const id = typeof node.id === "string" && node.id ? `#${node.id}` : "";
  const classes = [...(node.classList ?? [])].map((name) => `.${name}`).join("");
  const named = ["aria-label", "name", "role", "data-pane-id"]
    .map((name) => [name, node.getAttribute!(name)] as const)
    .filter(([, text]) => text !== null && text !== "")
    .map(([name, text]) => `[${name}=${JSON.stringify(clip(text!))}]`)
    .join("");
  return `${node.nodeName.toLowerCase()}${id}${classes}${named}${detached}`;
}

/** A check that held is still one `expect()` in the run's count, as the matcher it stands in for was. */
function pass(): void {
  expect(true).toBe(true);
}

function fail(message: string, caller: (...args: never[]) => unknown): never {
  const error = new Error(message);
  // Point the report at the assertion in the test, not at this file.
  Error.captureStackTrace?.(error, caller);
  throw error;
}

/** `actual` and `expected` are one and the same node (or both absent, as `toBe` would accept). */
export function expectSameNode(actual: unknown, expected: unknown): void {
  if (actual === expected) return pass();
  fail(`expected the same node\n  expected: ${describeNode(expected)}\n  received: ${describeNode(actual)}`, expectSameNode);
}

/** `actual` is not the node `other`: a replaced element, focus that moved on. */
export function expectDifferentNode(actual: unknown, other: unknown): void {
  if (actual !== other) return pass();
  fail(`expected a different node\n  received the same: ${describeNode(actual)}`, expectDifferentNode);
}

/** The same nodes in the same order: children after a re-render, what a spy was called with. */
export function expectSameNodes(actual: Iterable<unknown>, expected: readonly unknown[]): void {
  const received = [...actual];
  if (received.length === expected.length && received.every((node, index) => node === expected[index])) return pass();
  const list = (nodes: readonly unknown[]): string => nodes.length ? nodes.map((node) => `\n    ${describeNode(node)}`).join("") : " (none)";
  fail(`expected the same nodes in the same order\n  expected:${list(expected)}\n  received:${list(received)}`, expectSameNodes);
}
