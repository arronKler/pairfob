import { describe, expect, test } from "bun:test";
import { composeTransaction, installCommitRequester } from "./compose-transaction";

/**
 * Framework-neutral composition transaction seam.
 *
 * No React, DOM or App here: the test drives the narrow commit-request seam
 * directly, including the identity semantics the App host relies on — a
 * replacement requester owns the seam and a superseded disposer can never clear
 * it (the unmount-subscriber reentry / replacement-disposer contract).
 */
function fakeStore(initialDirty = true) {
  let published = 0;
  let dirty = initialDirty;
  return {
    publishes: () => published,
    isDirty: () => dirty,
    isCompositionPending: () => false,
    publish: () => {
      published += 1;
      dirty = false;
    },
  };
}

describe("composeTransaction", () => {
  test("headless: runs the body and publishes only the participating pending store", () => {
    const touched = fakeStore(true);
    const clean = fakeStore(false);
    let bodyRan = false;
    composeTransaction([touched, clean], () => {
      bodyRan = true;
    });
    expect(bodyRan).toBe(true);
    expect(touched.publishes()).toBe(1);
    // A participant that was not pending is not published headlessly.
    expect(clean.publishes()).toBe(0);
  });

  test("with a requester installed: the body runs and the host commits instead of publishing", () => {
    const store = fakeStore(true);
    let commits = 0;
    const dispose = installCommitRequester(() => {
      commits += 1;
    });
    try {
      composeTransaction([store], () => {});
      expect(commits).toBe(1);
      // The App owns publication; the transaction must not publish headlessly.
      expect(store.publishes()).toBe(0);
    } finally {
      dispose();
    }
  });

  test("releasing the requester restores headless publication", () => {
    const store = fakeStore(true);
    const dispose = installCommitRequester(() => {});
    dispose();
    composeTransaction([store], () => {});
    expect(store.publishes()).toBe(1);
  });

  test("a replacement host owns the seam; the superseded disposer cannot clear it", () => {
    const store = fakeStore(true);
    let aCommits = 0;
    let bCommits = 0;
    const disposeA = installCommitRequester(() => {
      aCommits += 1;
    });
    const disposeB = installCommitRequester(() => {
      bCommits += 1;
    });
    // B replaced A: A's release is a no-op against B's live seam.
    disposeA();
    composeTransaction([store], () => {});
    expect(aCommits).toBe(0);
    expect(bCommits).toBe(1);
    expect(store.publishes()).toBe(0); // B still owns publication.
    disposeB();
    // After B releases, headless publication resumes.
    composeTransaction([store], () => {});
    expect(store.publishes()).toBe(1);
  });
});
