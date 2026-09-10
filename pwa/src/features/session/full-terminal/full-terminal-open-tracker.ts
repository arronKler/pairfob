/** Tracks an in-flight TerminalOpen through its stale-controller cleanup. */
export class FullTerminalOpenTracker {
  private task: Promise<void> | null = null;

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

  pending(): Promise<void> {
    return this.task ?? Promise.resolve();
  }
}
