import type { SessionHandle, SessionOwner, SessionOwnerInput } from "./ports";

export type { SessionOwner, SessionOwnerInput } from "./ports";

const sessionKeys = new WeakMap<SessionHandle, number>();
let nextSessionKey = 0;
let owner: SessionOwner = { session: null, paneId: "", viewIncarnation: 0, key: "0::0" };

function keyFor(session: SessionHandle | null, paneId: string, viewIncarnation: number): string {
  let sessionKey = 0;
  if (session) {
    sessionKey = sessionKeys.get(session) ?? 0;
    if (!sessionKey) {
      sessionKey = ++nextSessionKey;
      sessionKeys.set(session, sessionKey);
    }
  }
  return `${sessionKey}:${paneId}:${viewIncarnation}`;
}

/** Bind session/pane/view identity in a controller transition, never during React render. */
export function adoptSessionOwner(input: SessionOwnerInput): SessionOwner {
  owner = {
    session: input.session,
    paneId: input.paneId,
    viewIncarnation: input.viewIncarnation,
    key: keyFor(input.session, input.paneId, input.viewIncarnation),
  };
  return owner;
}

export function sessionOwner(): SessionOwner {
  return owner;
}
