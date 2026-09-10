/**
 * Narrow session ports until captain supplies approved core domain actions.
 * This module must not import state, paint, or DOM globals.
 */

export type SessionHandle = object;

export type SessionViewKind = "guided" | "agent" | "full";

export type SessionOwnerInput = {
  session: SessionHandle | null;
  paneId: string;
  viewIncarnation: number;
};

export type SessionOwner = SessionOwnerInput & { key: string };

/** Read-only core surface. Implementations live in adapters, not this file. */
export type SessionCorePort = {
  owner(): SessionOwnerInput;
  viewKind(): SessionViewKind;
  paneText(): string;
  viewportRows(): number | undefined;
};
