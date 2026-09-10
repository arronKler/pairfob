import { installCommitRequester } from "../shared/model/compose-transaction";

/**
 * Mounted-application registry.
 *
 * This module is the inversion point between the imperative controllers and the
 * mounted `<App/>`. It deliberately imports nothing from the application graph:
 * a controller can reach the app without the app's screen imports reaching back,
 * which keeps the module graph acyclic.
 */
export type CommitOptions = { sync?: boolean };

export type AppHost = {
  /** Publish pending domain writes and render the composition once. */
  commit(options?: CommitOptions): void;
  /**
   * Ask for a commit on the next microtask. A caller that paints anyway cancels
   * it, so a navigation action still produces one commit.
   */
  requestCommit(): void;
  unmount(): void;
};

let host: AppHost | null = null;
let disposeCommitRequester: (() => void) | null = null;

export function registerAppHost(next: AppHost): void {
  host = next;
  // Own the composition-transaction commit seam for THIS host. The staged
  // navigation/compose actions ask for a commit through the installed host's own
  // requestCommit, so host replacement, observation and teardown all see one
  // seam. A replacement host installs its own requester and disposes the prior
  // one; releasing a superseded host is a no-op (identity checked below), so a
  // raced teardown can never clear a replacement mount's live seam.
  disposeCommitRequester?.();
  disposeCommitRequester = installCommitRequester(() => {
    next.requestCommit();
  });
}

export function releaseAppHost(current: AppHost): void {
  if (host !== current) return;
  // Clear our own references first, so a reentrant release during dispose never
  // observes a half-retired host and an old disposer can never clear a
  // replacement's seam.
  host = null;
  const dispose = disposeCommitRequester;
  disposeCommitRequester = null;
  dispose?.();
}

export function appHost(): AppHost | null {
  return host;
}

/**
 * Controller commit boundary.
 *
 * A feature controller that needs the arriving composition on screen right
 * away — a navigation it just declared, a focus/transition target it measures —
 * calls this boundary. It forwards to the installed
 * application host with synchronous intent, so it inherits the host's full
 * commit lifecycle: staged publication, frame preparation, declared-transition
 * consumption, shell, render.
 *
 * With no host installed — a headless fixture, a controller-only test — this
 * does nothing and mounts nothing. Ordinary same-page data updates stay on
 * their domain subscriptions and do not commit here. No React model or
 * getSnapshot may call it.
 */
export function commitView(): void {
  host?.commit({ sync: true });
}
