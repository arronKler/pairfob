import type { MediaContentCache } from './media-loader';

type Entry = { sha256: string; blob: Blob };

/** Page-lifetime LRU shared by previews, bounded across all computers and panes. */
export class PreviewCache {
  private entries = new Map<string, Entry>();
  private owners = new WeakMap<object, number>();
  private serial = 0;
  private bytes = 0;

  constructor(private maxBytes = 32 * 1024 * 1024, private maxFiles = 128) {}

  scope(owner: object, runtime: string | null, root: string, pane: string): MediaContentCache {
    let id = this.owners.get(owner);
    if (id === undefined) { id = ++this.serial; this.owners.set(owner, id); }
    const key = (path: string) => JSON.stringify([id, runtime, root, pane, path]);
    return {
      get: (path, open) => {
        const name = key(path), hit = this.entries.get(name);
        if (!hit) return;
        this.remove(name);
        if (hit.sha256 !== open.sha256 || hit.blob.size !== open.size) return;
        const blob = hit.blob.slice(0, hit.blob.size, open.mime);
        this.entries.set(name, { sha256: open.sha256, blob });
        this.bytes += blob.size;
        return blob;
      },
      put: (path, open, blob) => {
        const name = key(path);
        this.remove(name);
        if (blob.size > this.maxBytes || blob.size !== open.size) return;
        while (this.entries.size && (this.bytes + blob.size > this.maxBytes || this.entries.size >= this.maxFiles)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(name, { sha256: open.sha256, blob });
        this.bytes += blob.size;
      },
    };
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.blob.size; this.entries.delete(key); }
  }
}

export const previewCache = new PreviewCache();
