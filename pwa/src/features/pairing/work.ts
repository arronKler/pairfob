/**
 * Pairing attempt generation and connect-page ownership. Scan, paste and begin
 * capture the work id and the claiming page; an attempt also records the
 * handshake transport it started, keyed by that page. A ConnectScreen instance
 * claims the page; unmount retires the generation synchronously and hands the
 * transport back for owner-specific disposal, so a late reply cannot overwrite
 * a replacement and an old cleanup cannot abort a newer attempt. StrictMode
 * replays the same instance owner and restores that generation — a different
 * instance cannot. No timers.
 */

let pairingWork = 0;
let pairingPage: object | null = null;
let releasedOwner: object | null = null;
let workAtRelease = 0;
/** StrictMode replay may restore the released owner's generation only while no
 * real intent was claimed during the release window. A new intent invalidates
 * the reclaim snapshot so replay never rewinds past it. */
let reclaimEligible = false;
let transportAbort: AbortController | null = null;
let transportOwner: object | null = null;

export function pairingWorkId(): number {
  return pairingWork;
}

/**
 * A new pairing intent claims a fresh attempt generation — even one that later
 * fails local validation — so a landing captured before the intent can never
 * treat that intent's screen as its own. It also invalidates any pending
 * StrictMode reclaim snapshot: a later replay of the released page must not
 * rewind past this intent.
 */
export function claimPairingAttempt(): void {
  pairingWork += 1;
  reclaimEligible = false;
}

export function retirePairingWork(): void {
  pairingWork += 1;
  releasedOwner = null;
  reclaimEligible = false;
}

export function claimPairingPage(owner: object): void {
  if (releasedOwner === owner) {
    // Ordinary StrictMode replay restores the released attempt's generation so
    // the replayed instance continues it. But an explicit new intent claimed
    // during the release window (for example by this page's released transport
    // abort) already advanced the generation; restoring that snapshot would
    // rewind past the new attempt and discard its success. Keep the current
    // generation and hand the page to the newest intent instead.
    if (reclaimEligible) pairingWork = workAtRelease;
    releasedOwner = null;
    reclaimEligible = false;
    pairingPage = owner;
    return;
  }
  releasedOwner = null;
  reclaimEligible = false;
  if (pairingPage !== null && pairingPage !== owner) pairingWork += 1;
  pairingPage = owner;
}

export function releasePairingPage(owner: object): void {
  if (pairingPage !== owner) return;
  workAtRelease = pairingWork;
  pairingWork += 1;
  pairingPage = null;
  releasedOwner = owner;
  reclaimEligible = true;
}

/** The ConnectScreen instance currently claiming the pairing page, or null. */
export function pairingPageOwner(): object | null {
  return pairingPage;
}

/**
 * Record the handshake transport an attempt starts, keyed by the page that
 * started it. Unmount disposal aborts exactly this page's transport and never
 * a replacement attempt's.
 */
export function claimPairingTransport(owner: object | null, abort: AbortController): void {
  transportOwner = owner;
  transportAbort = abort;
}

/** The transport this page still owns, or null when a later attempt replaced it. */
export function pairingTransportAbortFor(owner: object): AbortController | null {
  return transportOwner === owner ? transportAbort : null;
}

/** Release this abort's claim; a different attempt's transport stays live. */
export function clearPairingTransport(abort: AbortController): void {
  if (transportAbort !== abort) return;
  transportOwner = null;
  transportAbort = null;
}
