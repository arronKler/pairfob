import { ProtocolError } from "./errors.ts";

export type TransportSwitchLease = symbol;

/** A generation-owned barrier for handing mutation capture from one transport to another. */
export class TransportSwitchBarrier {
  private owner: TransportSwitchLease | null = null;
  private pending: Promise<void> | null = null;
  private release: (() => void) | null = null;

  begin(): TransportSwitchLease {
    if (this.owner) throw new ProtocolError("conflict", "transport switch already active");
    const lease = Symbol("transport-switch");
    this.owner = lease;
    this.pending = new Promise<void>((resolve) => { this.release = resolve; });
    return lease;
  }

  owns(lease: TransportSwitchLease): boolean {
    return this.owner === lease;
  }

  wait(): Promise<void> | null {
    return this.pending;
  }

  end(lease: TransportSwitchLease): boolean {
    if (this.owner !== lease) return false;
    const release = this.release;
    this.owner = null;
    this.pending = null;
    this.release = null;
    release?.();
    return true;
  }
}
