import { createDirectOffer, DirectError, type DirectOffer } from "./direct-peer.ts";

type Preparation = {
  controller: AbortController;
  result: Promise<DirectOffer>;
  offer?: DirectOffer;
  unwatch(): void;
};

function browserNetwork(): EventTarget | undefined {
  if (typeof navigator === "undefined") return;
  const browser = navigator as Navigator & { connection?: EventTarget; mozConnection?: EventTarget; webkitConnection?: EventTarget };
  return browser.connection ?? browser.mozConnection ?? browser.webkitConnection;
}

/** One local ICE preparation, owned by a relay dial until the upgrade takes it.
 * No signaling RPC is sent here. Failures are consumed by the normal upgrade
 * attempt, so preparation never introduces an extra immediate retry.
 */
export class DirectOfferWarmup {
  private pending: Preparation | null = null;

  constructor(private readonly create = createDirectOffer, private readonly network = browserNetwork()) {}

  start(): void {
    if (this.pending) return;
    const controller = new AbortController();
    const changed = () => { if (this.pending === attempt) this.cancel(); };
    const attempt: Preparation = {
      controller,
      result: Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new DirectError("cancelled", "P2P 协商已取消");
        return this.create(controller.signal);
      }).then(offer => {
        if (controller.signal.aborted) {
          offer.close();
          throw new DirectError("cancelled", "P2P 协商已取消");
        }
        attempt.offer = offer;
        return offer;
      }),
      unwatch: () => this.network?.removeEventListener("change", changed),
    };
    this.pending = attempt;
    this.network?.addEventListener("change", changed);
    // Relay authentication may fail before an upgrade can consume this result.
    void attempt.result.catch(() => undefined);
  }

  cancel(): void {
    const attempt = this.pending;
    this.pending = null;
    attempt?.unwatch();
    attempt?.controller.abort();
    attempt?.offer?.close();
  }

  take(signal?: AbortSignal): Promise<DirectOffer> | undefined {
    const attempt = this.pending;
    this.pending = null;
    if (!attempt) return undefined;
    attempt.unwatch();
    return this.consume(attempt, signal);
  }

  private async consume(attempt: Preparation, signal?: AbortSignal): Promise<DirectOffer> {
    const abort = () => attempt.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      const offer = await attempt.result;
      if (attempt.controller.signal.aborted) {
        offer.close();
        throw new DirectError("cancelled", "P2P 协商已取消");
      }
      return offer;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
