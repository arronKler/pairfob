/**
 * Handing a finished download to the device.
 *
 * A page cannot open a path on disk, and there is no web call that starts a
 * saved file in its default app. The system share sheet is the one route that
 * exists: it lists the apps that can take the file, which on a phone includes
 * opening it. So the sheet offers this only when `canShare` accepts the actual
 * file — an entry that cannot work is worse than no entry.
 *
 * The price is memory: a share hands over a `File` the page built from the
 * received chunks, so only small downloads are kept for it. Everything larger
 * stays on disk with nothing left of it in the page.
 */

/** Above this size the finished file is not held in memory to be shared. */
export const SHARE_MAX_BYTES = 32 << 20;

type ShareData = { files: File[]; title?: string };
type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

function shareNavigator(): ShareNavigator | null {
  return typeof navigator === "undefined" ? null : navigator as unknown as ShareNavigator;
}

/** Whether the browser may share files at all, asked before one exists. */
export function shareCandidate(): boolean {
  const nav = shareNavigator();
  return typeof nav?.share === "function" && typeof nav.canShare === "function";
}

/** Whether this exact file can be handed to the system. */
export function canOpenOnDevice(file: File): boolean {
  const nav = shareNavigator();
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Hand the file to the system. Call it straight from the tap: iOS and Android
 * both require a user gesture, which an await before the call would spend.
 */
export function openOnDevice(file: File): Promise<void> {
  const nav = shareNavigator();
  if (typeof nav?.share !== "function") return Promise.reject(new Error("share is unavailable"));
  return nav.share({ files: [file], title: file.name });
}

/** A dismissed share sheet is an answer, not a failure. */
export function isShareCancel(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}
