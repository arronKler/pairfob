/** Tracks an in-flight TerminalOpen through its stale-controller cleanup. */
export class FullTerminalOpenTracker {
  private task: Promise<void> | null = null;
  private cancelPrepare: (() => void) | null = null;

  run(open: () => Promise<void>): Promise<void> {
    if (this.task) return this.task;
    const task = open();
    this.task = task;
    void task.then(
      () => { if (this.task === task) this.task = null; },
      () => { if (this.task === task) this.task = null; },
    );
    return task;
  }

  /** A read has no remote controller to clean up; leaving can stop waiting now. */
  prepare<T>(read: Promise<T>): Promise<{ value: T } | null> {
    let cancel!: () => void;
    const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); });
    this.cancelPrepare = cancel;
    return Promise.race([read.then(value => ({ value })), cancelled]).finally(() => {
      if (this.cancelPrepare === cancel) this.cancelPrepare = null;
    });
  }

  cancelPreparation(): void { this.cancelPrepare?.(); }

  pending(): Promise<void> {
    return this.task ?? Promise.resolve();
  }

  /** Abandon an in-flight open; its late result is still closed by the caller's version guard. */
  reset(): void {
    this.cancelPreparation();
    this.task = null;
  }
}
