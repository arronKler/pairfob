export type LiveInputPumpState = {
  queuedText: string;
  inFlightText: string;
  visibleText: string;
  scheduled: boolean;
  busy: boolean;
};

export type LiveInputFailure = {
  failedText: string;
  queuedText: string;
};

export type LiveInputPumpOptions = {
  send: (text: string) => Promise<unknown>;
  requestRead: () => void;
  onChange?: (state: LiveInputPumpState) => void;
  onError: (error: unknown, input: LiveInputFailure) => void | Promise<void>;
  schedule: (run: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

/**
 * Send the first live-input batch on the next paint, then keep one mutation in
 * flight and coalesce everything typed behind it. The read is queued directly
 * after SendText on the same ordered session so screen feedback costs one
 * network round trip instead of waiting for the mutation acknowledgement first.
 */
export class LiveInputPump {
  private queuedText = "";
  private inFlightText = "";
  private scheduled: unknown | null = null;
  private sending: Promise<unknown> | null = null;
  private readonly waiters: Array<(sent: boolean) => void> = [];
  private stopped = false;
  private failed = false;

  constructor(private readonly options: LiveInputPumpOptions) {}

  enqueue(text: string): boolean {
    if (!text || this.stopped || this.failed) return false;
    this.queuedText += text;
    this.notify();
    if (!this.sending && this.scheduled === null) {
      this.scheduled = this.options.schedule(() => {
        this.scheduled = null;
        this.drain();
      });
    }
    return true;
  }

  /** Flush every character queued before Enter and report whether it was sent. */
  flush(): Promise<boolean> {
    if (this.stopped || this.failed) return Promise.resolve(false);
    this.cancelScheduled();
    this.drain();
    if (!this.sending && !this.queuedText) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelScheduled();
    this.queuedText = "";
    this.inFlightText = "";
    this.sending = null;
    this.notify();
    this.resolveWaiters(false);
  }

  snapshot(): LiveInputPumpState {
    return {
      queuedText: this.queuedText,
      inFlightText: this.inFlightText,
      visibleText: this.inFlightText + this.queuedText,
      scheduled: this.scheduled !== null,
      busy: this.sending !== null,
    };
  }

  private cancelScheduled(): void {
    if (this.scheduled === null) return;
    this.options.cancel(this.scheduled);
    this.scheduled = null;
  }

  private drain(): void {
    if (this.stopped || this.failed || this.sending || !this.queuedText) return;
    const text = this.queuedText;
    this.queuedText = "";
    this.inFlightText = text;
    this.notify();

    let request: Promise<unknown>;
    try {
      request = Promise.resolve(this.options.send(text));
    } catch (error) {
      this.fail(error, text);
      return;
    }
    this.sending = request;
    // send() writes its encrypted frame synchronously before returning its
    // promise. The read therefore lands behind this mutation in session order.
    // A read failure never changes the delivery outcome of the mutation.
    try {
      this.options.requestRead();
    } catch {
      /* visible-page fallback polling will try the read again */
    }
    void request.then(
      () => this.settle(request),
      (error) => this.fail(error, text, request),
    );
  }

  private settle(request: Promise<unknown>): void {
    if (this.stopped || this.sending !== request) return;
    this.sending = null;
    this.inFlightText = "";
    if (this.queuedText) this.drain();
    else {
      this.notify();
      this.resolveWaiters(true);
    }
  }

  private fail(error: unknown, failedText: string, request?: Promise<unknown>): void {
    if (this.stopped || (request && this.sending !== request)) return;
    const queuedText = this.queuedText;
    this.sending = null;
    this.inFlightText = "";
    this.queuedText = "";
    this.failed = true;
    this.cancelScheduled();
    this.notify();
    let handled: Promise<void>;
    try {
      handled = Promise.resolve(this.options.onError(error, { failedText, queuedText }));
    } catch {
      this.resolveWaiters(false);
      return;
    }
    void handled
      .catch(() => undefined)
      .finally(() => this.resolveWaiters(false));
  }

  private notify(): void {
    this.options.onChange?.(this.snapshot());
  }

  private resolveWaiters(sent: boolean): void {
    for (const resolve of this.waiters.splice(0)) resolve(sent);
  }
}
