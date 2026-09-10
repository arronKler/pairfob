/**
 * Live-view generations.
 *
 * Every in-flight establish, GetConfig, Snapshot and pane read captures a
 * generation before it awaits. After the await it compares that token to the
 * current one: a newer establish, disconnect or computer switch must not let
 * old work publish into the new owner. The counters live here so lifecycle,
 * observation and openPane share one authority without importing live.ts.
 */
import { liveSession } from "../computers/catalog-store";
import type { LiveSession } from "../../lib/protocol/session-types";

let liveViewVersion = 0;
let herdConfigRequest = 0;
let establishAttempt = 0;
let paneNavigationSerial = 0;
let catalogRequest = 0;

export function liveView(): number {
  return liveViewVersion;
}

export function bumpLiveView(): number {
  liveViewVersion += 1;
  herdConfigRequest += 1;
  return liveViewVersion;
}

export function liveViewIsCurrent(
  session: LiveSession,
  viewVersion: number,
  current: LiveSession | null = liveSession(),
): boolean {
  return current === session && liveViewVersion === viewVersion;
}

export function nextHerdConfigRequest(): number {
  herdConfigRequest += 1;
  return herdConfigRequest;
}

export function herdConfigIsCurrent(request: number): boolean {
  return request === herdConfigRequest;
}

export function nextEstablishAttempt(): number {
  establishAttempt += 1;
  return establishAttempt;
}

export function establishAttemptIsCurrent(attempt: number): boolean {
  return attempt === establishAttempt;
}

/** A disconnect or a newer establish cancels an in-flight establish. */
export function cancelEstablish(): void {
  establishAttempt += 1;
}

export function nextPaneNavigation(): number {
  paneNavigationSerial += 1;
  return paneNavigationSerial;
}

export function paneNavigationIsCurrent(request: number): boolean {
  return request === paneNavigationSerial;
}

export function nextCatalogRequest(): number {
  catalogRequest += 1;
  return catalogRequest;
}

export function catalogRequestIsCurrent(request: number): boolean {
  return request === catalogRequest;
}

/** Test seam: start from generation zero so a suite does not inherit another. */
export function resetGenerationsForTests(): void {
  liveViewVersion = 0;
  herdConfigRequest = 0;
  establishAttempt = 0;
  paneNavigationSerial = 0;
  catalogRequest = 0;
}
