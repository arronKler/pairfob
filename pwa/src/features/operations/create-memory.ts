/**
 * What the create sheet remembers on this phone: which agent kinds the reader
 * pinned, how often and how recently each was started, the last few
 * "kind in workspace" combinations and the directories new workspaces were
 * created in.
 *
 * Device-local conveniences only. None of it is authority: the kinds offered
 * are always the ones the computer advertises, and a remembered directory is
 * still checked by the daemon like any other path.
 */
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { LAST_AGENT_KIND_KEY } from "./operation-form-model";

export const CREATE_MEMORY_KEY = "pairfob:createMemory";

const MAX_RECENTS = 3;
const MAX_DIRS = 5;

/**
 * Kinds starred before the reader has touched a star. Seeded once per phone:
 * the stored flag records it, so a later unpin sticks.
 */
export const DEFAULT_PINNED_KINDS: readonly string[] = ["claude", "codex"];
const SEEDED_FLAG = "pinsSeeded";

export type CreateCombo = { kind: string; workspaceId: string };

export type CreateMemory = {
  pinned: string[];
  uses: Record<string, number>;
  lastUsed: Record<string, number>;
  recents: CreateCombo[];
  dirs: string[];
};

const EMPTY: CreateMemory = { pinned: [], uses: {}, lastUsed: {}, recents: [], dirs: [] };

function unseeded(): CreateMemory {
  return { ...EMPTY, pinned: [...DEFAULT_PINNED_KINDS] };
}

function kindOk(value: unknown): value is string {
  return typeof value === "string" && value.length <= OPERATION_INPUT_LIMITS.agentKind;
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, stamp] of Object.entries(value)) {
    if (kindOk(key) && typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) out[key] = stamp;
  }
  return out;
}

/**
 * Parse stored memory, dropping anything malformed instead of failing. Memory
 * that has never carried the default pins gets them added.
 */
export function parseCreateMemory(raw: string | null): CreateMemory {
  let value: unknown;
  try {
    value = JSON.parse(raw || "null");
  } catch {
    return unseeded();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unseeded();
  const record = value as Record<string, unknown>;
  const stored = Array.isArray(record.pinned) ? record.pinned.filter((kind): kind is string => kindOk(kind) && kind !== "") : [];
  const pinned = record[SEEDED_FLAG] === true ? stored : [...DEFAULT_PINNED_KINDS, ...stored];
  const recents = Array.isArray(record.recents)
    ? record.recents.flatMap((item): CreateCombo[] => {
        if (!item || typeof item !== "object") return [];
        const { kind, workspaceId } = item as Record<string, unknown>;
        return kindOk(kind) && typeof workspaceId === "string" && workspaceId ? [{ kind, workspaceId }] : [];
      }).slice(0, MAX_RECENTS)
    : [];
  const dirs = Array.isArray(record.dirs)
    ? record.dirs.filter((dir): dir is string => typeof dir === "string" && dir !== "" && dir.length <= OPERATION_INPUT_LIMITS.cwd).slice(0, MAX_DIRS)
    : [];
  return { pinned: [...new Set(pinned)], uses: numbers(record.uses), lastUsed: numbers(record.lastUsed), recents, dirs };
}

/**
 * The stored memory, parsed once per stored value. The herd list reads it
 * during a render (an empty list offers the directories this phone created), so
 * a render that changes nothing must not parse the same string again. Every
 * reader gets a value it only copies: nothing here writes into it.
 */
let parsedRaw: string | null | undefined;
let parsedMemory: CreateMemory | null = null;

export function loadCreateMemory(): CreateMemory {
  try {
    const raw = localStorage.getItem(CREATE_MEMORY_KEY);
    if (parsedMemory && raw === parsedRaw) return parsedMemory;
    const memory = parseCreateMemory(raw);
    parsedRaw = raw;
    parsedMemory = memory;
    return memory;
  } catch {
    return unseeded();
  }
}

function save(memory: CreateMemory): void {
  try {
    localStorage.setItem(CREATE_MEMORY_KEY, JSON.stringify({ ...memory, [SEEDED_FLAG]: true }));
  } catch {
    /* storage blocked; the next sheet just starts from defaults */
  }
}

export function togglePinnedKind(kind: string): CreateMemory {
  const memory = loadCreateMemory();
  const pinned = memory.pinned.includes(kind) ? memory.pinned.filter((item) => item !== kind) : [...memory.pinned, kind];
  const next = { ...memory, pinned };
  save(next);
  return next;
}

/** Record a create the reader confirmed. `kind` is "" for a plain terminal. */
export function rememberCreate(input: { kind: string; workspaceId?: string; cwd?: string }, at = Date.now()): void {
  const memory = loadCreateMemory();
  const next: CreateMemory = { ...memory };
  if (input.kind) {
    next.uses = { ...memory.uses, [input.kind]: (memory.uses[input.kind] ?? 0) + 1 };
    next.lastUsed = { ...memory.lastUsed, [input.kind]: at };
  }
  if (input.workspaceId) {
    next.recents = [{ kind: input.kind, workspaceId: input.workspaceId },
      ...memory.recents.filter((item) => item.kind !== input.kind || item.workspaceId !== input.workspaceId)].slice(0, MAX_RECENTS);
  }
  if (input.cwd) next.dirs = [input.cwd, ...memory.dirs.filter((dir) => dir !== input.cwd)].slice(0, MAX_DIRS);
  save(next);
  try {
    localStorage.setItem(LAST_AGENT_KIND_KEY, input.kind.slice(0, OPERATION_INPUT_LIMITS.agentKind));
  } catch {
    /* storage blocked */
  }
}

/** Favourite slots: with the terminal and "all" they fill two rows of four. */
export const FAVORITE_SLOTS = 6;

/**
 * The kinds the grid shows: pinned first, then by use, restricted to what the
 * computer advertises. A kind picked from the full list takes the last slot.
 */
export function favoriteKinds(advertised: readonly string[], memory: CreateMemory, selected = ""): string[] {
  const order = [...advertised].sort((left, right) =>
    Number(memory.pinned.includes(right)) - Number(memory.pinned.includes(left))
    || (memory.uses[right] ?? 0) - (memory.uses[left] ?? 0)
    || advertised.indexOf(left) - advertised.indexOf(right));
  let top = order.slice(0, FAVORITE_SLOTS);
  if (selected && advertised.includes(selected) && !top.includes(selected)) top = [...top.slice(0, FAVORITE_SLOTS - 1), selected];
  return top;
}
