import { ProtocolError } from "./protocol/errors";
import type { LiveSession } from "./protocol/session-types";
import type { GitLayer, GitStatus, WorkspaceDescriptor } from "./workspace";

export const WORKSPACE_CACHE_TTL_MS = 5_000;
export const WORKSPACE_CACHE_ROOT_LIMIT = 6;
export const WORKSPACE_CACHE_ENTRY_LIMIT = 48;
export const WORKSPACE_CACHE_BYTES_PER_ROOT = 2 * 1024 * 1024;

type Session = Pick<LiveSession, "workspaceOpen" | "workspaceList" | "workspaceRead" | "gitStatus" | "gitDiff" | "gitBranches">;
export type WorkspaceRead<T> = { cached: T | undefined; value: Promise<T> };
type Entry = { data?: unknown; loadedAt: number; bytes: number; flight?: Promise<unknown> };
type Binding = { cwd: string | undefined; scope?: WorkspaceScope; loadedAt: number; flight?: Promise<WorkspaceScope> };

function movedWorkspace(): ProtocolError {
  return new ProtocolError("workspace_not_found", "The pane's workspace changed. Open its files again.");
}

class RootCache {
  private entries = new Map<string, Entry>();

  clear(except?: string): void {
    for (const key of this.entries.keys()) if (key !== except) this.entries.delete(key);
  }

  read<T>(key: string, load: () => Promise<T>, now: () => number): WorkspaceRead<T> {
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      const cached = entry.data as T | undefined;
      if (entry.flight) return { cached, value: entry.flight as Promise<T> };
      if (cached !== undefined && now() - entry.loadedAt < WORKSPACE_CACHE_TTL_MS) {
        return { cached, value: Promise.resolve(cached) };
      }
    } else {
      entry = { loadedAt: 0, bytes: 0 };
      this.entries.set(key, entry);
    }
    const target = entry;
    const cached = target.data as T | undefined;
    const value = Promise.resolve().then(load).then((data) => {
      if (this.entries.get(key) === target) {
        target.data = data;
        target.loadedAt = now();
        target.bytes = JSON.stringify(data).length * 2;
        delete target.flight;
        this.trim();
      }
      return data;
    }, (error) => {
      if (this.entries.get(key) === target) this.entries.delete(key);
      throw error;
    });
    target.flight = value;
    this.trim();
    return { cached, value };
  }

  private trim(): void {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= WORKSPACE_CACHE_ENTRY_LIMIT && bytes <= WORKSPACE_CACHE_BYTES_PER_ROOT) break;
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }
}

/** One authenticated connection owns its directory data and pane-to-root bindings. */
export class WorkspaceReadCache {
  private roots = new Map<string, RootCache>();
  private bindings = new Map<string, Binding>();

  constructor(
    private session: Session,
    private cwdOf: (paneId: string) => string | undefined,
    private now: () => number = () => Date.now(),
  ) {}

  async open(paneId: string, force = false): Promise<WorkspaceScope> {
    const cwd = this.cwdOf(paneId);
    const previous = this.bindings.get(paneId);
    if (!force && previous && previous.cwd === cwd) {
      if (previous.flight) return previous.flight;
      if (previous.scope && this.now() - previous.loadedAt < WORKSPACE_CACHE_TTL_MS) return previous.scope;
    }
    if (force && previous?.scope) this.invalidate(previous.scope.descriptor.root);
    // Rechecking an unchanged root must not revoke reads already in progress.
    const binding: Binding = !force && previous && previous.cwd === cwd ? previous : { cwd, loadedAt: 0 };
    this.bindings.delete(paneId);
    this.bindings.set(paneId, binding);
    while (this.bindings.size > 64) this.bindings.delete(this.bindings.keys().next().value!);
    const valid = () => this.bindings.get(paneId) === binding && this.cwdOf(paneId) === cwd;
    const flight = this.session.workspaceOpen(paneId).then((descriptor) => {
      if (!valid()) throw movedWorkspace();
      if (force) this.invalidate(descriptor.root);
      const target: Binding = binding.scope && binding.scope.descriptor.root !== descriptor.root ? { cwd, loadedAt: 0 } : binding;
      this.bindings.set(paneId, target);
      target.scope = new WorkspaceScope(descriptor, this.session, paneId,
        () => this.bindings.get(paneId) === target && this.cwdOf(paneId) === cwd, this);
      target.loadedAt = this.now();
      delete binding.flight;
      return target.scope;
    }).catch((error) => {
      if (this.bindings.get(paneId) === binding) this.bindings.delete(paneId);
      throw error;
    });
    binding.flight = flight;
    return flight;
  }

  invalidate(root: string): void {
    this.roots.get(root)?.clear();
  }

  read<T>(root: string, key: string, load: () => Promise<T>): WorkspaceRead<T> {
    let cache = this.roots.get(root);
    this.roots.delete(root);
    if (!cache) cache = new RootCache();
    this.roots.set(root, cache);
    while (this.roots.size > WORKSPACE_CACHE_ROOT_LIMIT) this.roots.delete(this.roots.keys().next().value!);
    return cache.read(key, load, this.now);
  }

  changedStatus(root: string, previous: GitStatus | undefined, next: GitStatus): void {
    if (previous && (previous.revision !== next.revision || previous.head !== next.head || previous.branch !== next.branch)) {
      this.roots.get(root)?.clear("status");
    }
  }
}

/** Reads still use the active pane for authorization; only verified roots share results. */
export class WorkspaceScope {
  constructor(
    readonly descriptor: WorkspaceDescriptor,
    private session: Session,
    private paneId: string,
    private valid: () => boolean,
    private cache: WorkspaceReadCache,
  ) {}

  private read<T>(key: string, load: () => Promise<T>): WorkspaceRead<T> {
    if (!this.valid()) return { cached: undefined, value: Promise.reject(movedWorkspace()) };
    const result = this.cache.read(this.descriptor.root, key, async () => {
      const value = await load();
      if (!this.valid()) throw movedWorkspace();
      return value;
    });
    return {
      cached: result.cached,
      value: result.value.then((value) => {
        if (!this.valid()) throw movedWorkspace();
        return value;
      }),
    };
  }

  directory(path: string, cursor = "") {
    return this.read(JSON.stringify(["directory", path, cursor]), () => this.session.workspaceList(this.paneId, path, cursor, 120));
  }

  file(path: string) {
    return this.read(JSON.stringify(["file", path]), () => this.session.workspaceRead(this.paneId, path));
  }

  diff(path: string, layer: GitLayer) {
    return this.read(JSON.stringify(["diff", path, layer]), () => this.session.gitDiff(this.paneId, path, layer));
  }

  status() {
    const result = this.read("status", () => this.session.gitStatus(this.paneId));
    return {
      cached: result.cached,
      value: result.value.then((next) => {
        this.cache.changedStatus(this.descriptor.root, result.cached, next);
        return next;
      }),
    };
  }

  branches() {
    return this.read("branches", () => this.session.gitBranches(this.paneId));
  }
}
