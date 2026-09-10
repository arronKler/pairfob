import type { ConnectionDetails } from "./connection-diagnostics.ts";
export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly diagnostics?: ConnectionDetails,
  ) {
    super(message || code);
    this.name = "ProtocolError";
  }
}
