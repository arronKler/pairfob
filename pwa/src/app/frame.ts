import type { LiveSession } from "../lib/protocol/client";
import { layoutsEqual, type LayoutDescriptor } from "./layout";
import { createDomain, detach, type DomainView, type Immutable } from "../shared/model/domain-store";

/**
 * The per-commit frame: the view data a page needs that must not be computed
 * during a React render.
 *
 * This module owns the published snapshot. Imperative preparation — herd
 * attention consumption, terminal adoption, session paint — lives in
 * `frame-prepare.ts` so importing the frame store does not load painters or
 * query `#app`. Herd attention itself is consumed once per home/desk
 * composition by the `pages/home` bridge, whose route owns the subscribed
 * attention model; the frame no longer carries a herd projection.
 *
 * Everything the frame owns is plain data and publishes frozen: the layout, the
 * scroll snapshot and the session metadata. Only one value keeps identity as a
 * live resource: the session itself.
 */
export type SessionScroll = { top: number; left: number; bottom: boolean };

/** Which session controller the composition displays, if any. */
export type SessionKind = "guided" | "chat" | "terminal";

/** The displayed session, described before the page renders. */
export type SessionBinding = { kind: SessionKind; paneId: string; incarnation: number };

export type AppFrame = {
  layout: LayoutDescriptor | null;
  scroll: SessionScroll | null;
  session: SessionBinding | null;
  sessionOwner: LiveSession | null;
};

const EMPTY_FRAME: AppFrame = {
  layout: null,
  scroll: null,
  session: null,
  sessionOwner: null,
};

const frameDomain = createDomain<AppFrame, "sessionOwner">("app-frame", { ...EMPTY_FRAME },
  { opaque: ["sessionOwner"] });
export const frameStore = frameDomain.store;
const { read, write } = frameDomain.controller;

export function subscribeAppFrame(listener: () => void): () => void {
  return frameStore.subscribe(listener);
}

/** The published frame: owned data read-only, the session handle by identity. */
export type FrameSnapshot = DomainView<AppFrame, "sessionOwner">;

export function getAppFrame(): FrameSnapshot {
  return frameStore.get();
}

/** Which session controller the composition displays, phone or desk alike. */
export function displayedSession(layout: LayoutDescriptor): SessionKind | null {
  if (layout.mode === "full-terminal") return "terminal";
  if (layout.mode === "chat" || layout.deskChild === "chat") return "chat";
  if (layout.mode === "pane" || layout.deskChild === "session") return "guided";
  return null;
}

/**
 * The session owner preparer seam.
 *
 * The frame describes the session this commit displays — controller kind, pane and
 * view incarnation, plus the live session handle — before React renders. The
 * session feature registers the adoption that turns that description into its own
 * bound owner here, so every composition boundary (phone chat, desk chat, guided,
 * complete terminal) prepares ownership in one place instead of per route.
 *
 * The description handed over is frozen and the frame keeps a detached copy, so a
 * preparer cannot edit what the frame publishes, and the preparer binds exactly
 * the supplied handle and incarnation instead of re-reading a replacement the
 * domains may have published by the time a later callback runs.
 *
 * Production binds the live owner by registering `registerSessionView` from
 * `features/session/register.ts` (the leaf, not the `features/session` barrel)
 * on this seam after hydrate and before `mountApp`, and clears the seam when the
 * page lifecycle stops. Do not call it from a React render, use it as a
 * getSnapshot, or store its mutable SessionOwner on the frame.
 */
export type SessionOwnerPreparer = (session: Readonly<SessionBinding>, owner: LiveSession | null) => void;

let prepareSessionOwner: SessionOwnerPreparer | null = null;

export function registerSessionOwnerPreparer(preparer: SessionOwnerPreparer | null): void {
  prepareSessionOwner = preparer;
}

/** The currently bound preparer, if any. Fixtures inspect the seam before injecting. */
export function sessionOwnerPreparer(): SessionOwnerPreparer | null {
  return prepareSessionOwner;
}

/** Hand the frozen session description to the registered owner, if any. */
export function notifySessionOwnerPreparer(
  session: Readonly<SessionBinding>,
  owner: LiveSession | null,
): void {
  prepareSessionOwner?.(session, owner);
}

/** Publish a derived layout onto the frame without re-running page preparation. */
export function syncFrameLayout(layout: LayoutDescriptor | Immutable<LayoutDescriptor>): void {
  if (layoutsEqual(read().layout, layout as LayoutDescriptor)) return;
  write((record) => {
    record.layout = detach(layout) as LayoutDescriptor;
  });
}

/** Adopt prepared view data as the published frame. */
export function adoptPreparedFrame(
  next: Omit<AppFrame, "layout"> & { layout: LayoutDescriptor | Immutable<LayoutDescriptor> },
): FrameSnapshot {
  write((record) => {
    record.layout = detach(next.layout) as LayoutDescriptor;
    record.scroll = next.scroll ? detach(next.scroll) : null;
    record.session = next.session ? detach(next.session) : null;
    record.sessionOwner = next.sessionOwner;
  });
  return frameStore.get();
}

/** Drop prepared view data when the application unmounts. */
export function resetFrame(): void {
  write((record) => {
    Object.assign(record, { ...EMPTY_FRAME, sessionOwner: null });
  });
}
