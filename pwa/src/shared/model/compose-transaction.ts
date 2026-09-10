import { batch, beginPublicationTransaction, endPublicationTransaction, type DomainStore } from "./domain-store";

/**
 * Composition transactions (framework-neutral).
 *
 * A write that changes which page the application shows must not be observable
 * before the composition that follows from it: a subscriber would see the new
 * screen while the prepared frame still describes the old page, and a page that
 * reads its own domain would render inside the wrong shell for one pass.
 *
 * So such an action stages its write and lets one commit publish the domain
 * snapshot, the frame and the shell together. A headless caller — a script, a
 * pure state test, anything without a mounted application — has no composition to
 * wait for, so the staged writes publish immediately instead, as one batch.
 *
 * This module imports no App, React, screen or host. The mounted App owns the
 * inversion: on mount it installs a narrow `requestCommit` callback that asks its
 * own commit pipeline to run, and on unmount it releases that callback by
 * identity. With nothing installed the transaction publishes the participating
 * stores headlessly.
 */
type Publishable = Pick<DomainStore<object, never>, "isDirty" | "isCompositionPending" | "publish">;

/** The one seam a host installs: ask the mounted application to commit. */
export type CommitRequester = () => void;

let installed: { requester: CommitRequester; token: number } | null = null;
let nextToken = 0;

/**
 * Install the host's commit request and return its disposer.
 *
 * Identity-safe: a replacement host installs its own requester and gets its own
 * disposer. Releasing the older host never clears the newer requester, so a
 * replacement mount that raced a teardown keeps the live commit seam.
 */
export function installCommitRequester(requester: CommitRequester): () => void {
  const token = ++nextToken;
  installed = { requester, token };
  return () => {
    // Only clear the seam this disposer installed; a replacement owns it now.
    if (installed?.token === token) installed = null;
  };
}

/** The installed requester, or null with no mounted application. */
function commitRequester(): CommitRequester | null {
  return installed?.requester ?? null;
}

export function composeTransaction(stores: readonly Publishable[], body: () => void): void {
  body();
  const requestCommit = commitRequester();
  if (requestCommit) {
    requestCommit();
    return;
  }
  // Headless: publish every store the transaction touched as one batch, so a
  // subscriber of one domain never sees it before a sibling domain it depends on.
  beginPublicationTransaction();
  try {
    batch(() => {
      for (const store of stores) {
        if (store.isDirty() || store.isCompositionPending()) store.publish();
      }
    });
  } finally {
    endPublicationTransaction();
  }
}
