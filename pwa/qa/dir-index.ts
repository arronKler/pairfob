/**
 * The directory index a QA computer answers with. Two roots so the picker's
 * grouping and a row's parent path both show something, and the version the
 * daemon hashes so a repeat read answers `unchanged`.
 */
export const DIR_INDEX_VERSION = "5c1e7a2b9d3f4a60";

export function dirIndex(version = "") {
  if (version === DIR_INDEX_VERSION) return { unchanged: true };
  return {
    version: DIR_INDEX_VERSION,
    roots: [
      { path: "/work", repo: false, dirs: [
        { p: "pairfob", r: true },
        { p: "pairfob/pwa" },
        { p: "pairfob/pwa/src" },
        { p: "pairfob/internal" },
        { p: "pairfob/proto" },
        { p: "scratch" },
      ] },
      { path: "/Users/qa/Documents", repo: false, dirs: [
        { p: "notes" },
        { p: "notes/archive" },
      ] },
    ],
    truncated: false,
  };
}
