/**
 * Git status projections the inspector draws everywhere a path is listed:
 * per-file marks, per-directory change counts, the change-list sections and
 * the review order the diff stepper walks. Pure functions over the status the
 * workspace already loaded, so no extra reads.
 */
import { gitChangeKind, gitLayers, type GitChange, type GitChangeKind, type GitLayer } from "../../lib/workspace";

type Change = Readonly<GitChange>;
type StatusLike = { readonly changes: ReadonlyArray<Change>; readonly truncated: boolean } | null | undefined;

export type ChangeSection = "conflict" | "staged" | "worktree";

/** One reviewable diff: a path in one layer. */
export type ChangeStep = { path: string; layer: GitLayer; kind: GitChangeKind; change: Change };

export type GitMarks = {
  /** The mark a file row shows: its worktree kind, else its staged kind. */
  files: ReadonlyMap<string, GitChangeKind>;
  /** Changed files below each directory path (every ancestor counts). */
  dirs: ReadonlyMap<string, number>;
  truncated: boolean;
};

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Unmerged entries, including both-added and both-deleted. */
export function isConflict(change: Change): boolean {
  return CONFLICT_PAIRS.has(`${change.index}${change.worktree}`);
}

/**
 * Change-list sections in display order. A conflict is listed once, in its own
 * section, never again under staged or worktree.
 */
export function changeSections(changes: ReadonlyArray<Change>): Record<ChangeSection, ChangeStep[]> {
  const sections: Record<ChangeSection, ChangeStep[]> = { conflict: [], staged: [], worktree: [] };
  for (const change of changes) {
    if (isConflict(change)) {
      sections.conflict.push({ path: change.path, layer: "worktree", kind: "conflict", change });
      continue;
    }
    for (const layer of gitLayers(change)) {
      sections[layer].push({ path: change.path, layer, kind: gitChangeKind(change, layer), change });
    }
  }
  return sections;
}

/**
 * One row of the change list: a diff, and for a file changed in both layers its
 * staged diff as a tag on the same row.
 */
export type ChangeRowItem = { step: ChangeStep; staged?: ChangeStep };

export type ListedChanges = {
  /**
   * The groups in display order, each with the rows it draws; a group without
   * rows is left out. `files` is how many files the whole group holds, drawn
   * or not: what its title says, a row with a staged tag being one.
   */
  groups: Array<{ section: ChangeSection; rows: ChangeRowItem[]; files: number }>;
  /** Every diff the rows hold, top to bottom: what the stepper walks. */
  order: ChangeStep[];
  /** Rows past `limit`, which the list offers to draw next. */
  hidden: number;
};

const SECTION_ORDER: readonly ChangeSection[] = ["conflict", "staged", "worktree"];

/**
 * The diffs a row holds, in the order they stand on it and the keyboard reaches
 * them: the row's own, then its staged tag.
 */
export function rowSteps(row: ChangeRowItem): ChangeStep[] {
  return row.staged ? [row.step, row.staged] : [row.step];
}

/**
 * The change list as it is drawn, and the order that goes with it. Both come
 * from here so that they cannot disagree: conflicts, the files that are only
 * staged, then the working tree's. A file changed in both layers is one row,
 * under the working tree, where the file is as it stands; its staged diff is a
 * tag on that row and not a second row among the staged files.
 *
 * `limit` caps the rows drawn, counted down the list across the groups, and
 * the order returned is of those rows. Without it this is the whole list: the
 * stepper walks all of it, and the list is drawn on as far as the diff it
 * opens (`loadGitDiff`).
 */
export function listedChanges(changes: ReadonlyArray<Change>, limit = Number.POSITIVE_INFINITY): ListedChanges {
  // The whole list is asked for on every render of the header, the overview and
  // the changes column; one status is one answer, as with `gitMarks`.
  if (limit === Number.POSITIVE_INFINITY) {
    const cached = listedCache.get(changes);
    if (cached) return cached;
    const built = buildListed(changes, limit);
    listedCache.set(changes, built);
    return built;
  }
  return buildListed(changes, limit);
}

const listedCache = new WeakMap<object, ListedChanges>();

function buildListed(changes: ReadonlyArray<Change>, limit: number): ListedChanges {
  const sections = changeSections(changes);
  const worktree = new Set(sections.worktree.map((step) => step.path));
  const tags = new Map(sections.staged.filter((step) => worktree.has(step.path)).map((step) => [step.path, step]));
  const rows: Record<ChangeSection, ChangeRowItem[]> = {
    conflict: sections.conflict.map((step) => ({ step })),
    staged: sections.staged.filter((step) => !tags.has(step.path)).map((step) => ({ step })),
    worktree: sections.worktree.map((step) => ({ step, staged: tags.get(step.path) })),
  };
  let room = Math.max(0, limit);
  let hidden = 0;
  const groups: ListedChanges["groups"] = [];
  for (const section of SECTION_ORDER) {
    const all = rows[section];
    const drawn = all.slice(0, room);
    room -= drawn.length;
    hidden += all.length - drawn.length;
    if (drawn.length) groups.push({ section, rows: drawn, files: all.length });
  }
  return { groups, order: groups.flatMap((group) => group.rows.flatMap(rowSteps)), hidden };
}

/** The order the diff stepper walks: every listed diff, from the top of the list to its end. */
export function reviewOrder(changes: ReadonlyArray<Change>): ChangeStep[] {
  return listedChanges(changes).order;
}

/** Layers a path can be diffed in; a conflict only offers the worktree. */
export function layersFor(changes: ReadonlyArray<Change>, path: string): GitLayer[] {
  const change = changes.find((item) => item.path === path);
  if (!change) return [];
  return isConflict(change) ? ["worktree"] : gitLayers(change);
}

const cache = new WeakMap<object, GitMarks>();

export function gitMarks(status: StatusLike): GitMarks {
  if (!status) return { files: new Map(), dirs: new Map(), truncated: false };
  const cached = cache.get(status);
  if (cached) return cached;
  const files = new Map<string, GitChangeKind>();
  const dirs = new Map<string, number>();
  for (const change of status.changes) {
    const layers = gitLayers(change);
    const kind = isConflict(change) ? "conflict"
      : layers.includes("worktree") ? gitChangeKind(change, "worktree")
      : gitChangeKind(change, layers[0] ?? "worktree");
    files.set(change.path, kind);
    const parts = change.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const marks = { files, dirs, truncated: status.truncated };
  cache.set(status, marks);
  return marks;
}

/**
 * Breadcrumb segments that stay visible. Past three segments the middle folds
 * into one "…" entry: root, fold, parent, current.
 */
export function foldBreadcrumbs<T extends { path: string }>(crumbs: readonly T[]): Array<T | { fold: true; path: string }> {
  if (crumbs.length <= 3) return [...crumbs];
  return [crumbs[0], { fold: true, path: crumbs[crumbs.length - 3].path }, crumbs[crumbs.length - 2], crumbs[crumbs.length - 1]];
}

/** Rename rules shared by the live form check and the final submit guard. */
export function fileNameProblem(value: string): "empty" | "reserved" | "separator" | "tooLong" | null {
  if (!value.trim()) return "empty";
  if (value === "." || value === ".." || value.toLowerCase() === ".git") return "reserved";
  if (/[/\\\p{Cc}]/u.test(value)) return "separator";
  if (new TextEncoder().encode(value).length > 255) return "tooLong";
  return null;
}
