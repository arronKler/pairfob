/**
 * One order for everything sent to a guided session's program.
 *
 * What the reader types and presses leaves on several paths. Characters go
 * through the live pump (`live-input`), which keeps one write in flight and
 * holds what is typed behind it; keys go through the key queue (`keys`), which
 * does the same with its own batches; a wheel notch goes through a terminal
 * bridge that may still be opening (`guided-scroll`); a page key is written
 * directly once the keys before it have settled (`sendPage`). Each path keeps
 * its own order, but a unit written while another path was still holding an
 * earlier one reached the program first: over a slow link `a b ⌫ c` arrived as
 * `a ⌫ bc`, `ls ⏎ pwd ⏎` as `lspwd ⏎ ⏎`, and a PageUp pressed between two
 * characters ahead of both.
 *
 * The session's socket is ordered and the computer handles a session's writes
 * in the order they arrive, so nothing has to wait for an answer: a unit only
 * has to wait until what was typed before it has been written. A unit is
 * handed to its path at once when nothing is waiting and no other path holds
 * anything back, which is every key and character on a quick link; otherwise
 * it takes its turn.
 */
export type LivePath = {
  /** Something typed is still held here, not yet written to the session. */
  unsent: () => boolean;
  /** Settles when what is held now has been written, or never will be. */
  written: () => Promise<unknown>;
};

type Unit = { dropped?: () => void };

export class LiveOrder {
  private tail: Promise<void> | null = null;
  private generation = 0;
  private readonly units = new Set<Unit>();

  constructor(private readonly paths: ReadonlyMap<string, LivePath>) {}

  /**
   * Hand one unit to its path with `send`: now, or when everything typed before
   * it has been written. `path` names the path the unit joins (it keeps its own
   * order with what that path already holds); null is a unit that writes
   * directly and so waits for every path. A `send` that returns a promise has
   * not written until it settles, and what follows waits for that. `dropped`
   * is told when the unit will never be sent (`reset`).
   */
  submit(path: string | null, send: () => void | Promise<unknown>, dropped?: () => void): void {
    const held = (): LivePath | undefined => {
      for (const [name, other] of this.paths) if (name !== path && other.unsent()) return other;
      return undefined;
    };
    if (!this.tail && !held()) {
      const writing = send();
      if (writing) this.follow(Promise.resolve(writing));
      return;
    }
    const generation = this.generation;
    const unit: Unit = { dropped };
    this.units.add(unit);
    this.follow((this.tail ?? Promise.resolve()).then(async () => {
      for (let other = held(); generation === this.generation && other; other = held()) await other.written();
      if (generation !== this.generation) return;
      this.units.delete(unit);
      await send();
    }));
  }

  private follow(work: Promise<unknown>): void {
    const turn: Promise<void> = work.catch(() => undefined).then(() => {
      if (this.tail === turn) this.tail = null;
    });
    this.tail = turn;
  }

  /** Whether a unit is waiting for its turn, or still writing. */
  waiting(): boolean {
    return this.tail !== null;
  }

  /** Settles once nothing is waiting: everything typed so far has been handed to its path. */
  async drained(): Promise<void> {
    while (this.tail) await this.tail;
  }

  /**
   * Drop what is waiting. The pane changed, or a write failed: what was typed
   * after it must not arrive on its own (an Enter without its command).
   */
  reset(): void {
    this.generation += 1;
    this.tail = null;
    const dropped = [...this.units];
    this.units.clear();
    for (const unit of dropped) unit.dropped?.();
  }
}

const paths = new Map<string, LivePath>();

/** The guided session's order. Each path registers itself; importing one of them is enough to be in it. */
export const liveOrder = new LiveOrder(paths);

export function registerLivePath(name: string, path: LivePath): void {
  paths.set(name, path);
}
