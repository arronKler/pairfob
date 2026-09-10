import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { resetTestDOM } from "../../test-support/boot-dom";
import { appRoot, bindAppRoot, releaseAppRoot } from "./dom-root";

/**
 * Root/body reset contract for the DOM root adapter and the generic Happy DOM
 * realm helper.
 *
 * resetTestDOM must restore the currently BOUND root across realm/body resets
 * through the DOM adapter alone (no state facade): the bound node is the one
 * the mounted React root lives on, so reconnecting that exact node preserves
 * the host and its fields. A node adopted by a different realm is auto-adopted
 * back (appendChild re-parents cross-document), and an existing replacement
 * <main id=app> does not steal the bound identity. These run under the default
 * `bun test src` gate.
 */

async function freshRealm(): Promise<void> {
  releaseAppRoot();
  document.body.innerHTML = '<main id="app"></main>';
  await resetTestDOM();
}

afterAll(() => {
  releaseAppRoot();
  document.body.innerHTML = '<main id="app"></main>';
});

test("ordinary connected reset retains the bound real app root", async () => {
  await freshRealm();
  const first = appRoot();
  await resetTestDOM();
  expect(appRoot()).toBe(first);
  expect(first.isConnected).toBeTrue();
  expect(first.ownerDocument).toBe(document);
});

test("a body cleared to no app reconnects the already bound root", async () => {
  await freshRealm();
  const retained = appRoot();
  document.body.replaceChildren();
  await resetTestDOM();
  expect(appRoot()).toBe(retained);
  expect(retained.isConnected).toBeTrue();
});

test("a replacement <main id=app> does not steal the cached bound root identity", async () => {
  await freshRealm();
  const retained = appRoot();
  document.body.innerHTML = '<main id="app">replacement</main>';
  await resetTestDOM();
  // The bound node is the identity restored even beside a replacement.
  expect(retained.isConnected).toBeTrue();
  expect(appRoot()).toBe(retained);
});

test("a connected bound root adopted by another realm is restored to the helper realm", async () => {
  await freshRealm();
  const retained = appRoot();
  // A separate Happy DOM realm adopts the mounted node (its realm becomes foreign).
  const foreign = new Window({ url: "https://pairfob.com/pair" });
  foreign.document.body.append(retained);
  Object.assign(globalThis, { window: foreign, document: foreign.document });
  expect(retained.ownerDocument).toBe(foreign.document);
  await resetTestDOM();
  expect(appRoot()).toBe(retained);
  expect(retained.isConnected).toBeTrue();
  expect(retained.ownerDocument).toBe(document);
  await foreign.happyDOM.abort();
});
