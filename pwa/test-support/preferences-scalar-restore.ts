import {
  DEFAULT_COMPOSE_LIVE_KEY,
  KEYS_EXPANDED_KEY,
  PAD_KIND_KEY,
  TERM_WRAP_KEY,
  defaultComposeLive,
  keysExpanded,
  padKind,
  setDefaultComposeLive,
  setKeysExpanded,
  setPadKind,
  setTermWrap,
  termWrap,
} from "../src/features/settings/preferences-store";

/**
 * Narrow capture/restore for the four simple scalar preferences that leaf
 * fixtures reset through their real setters (setTermWrap / setDefaultComposeLive
 * / setKeysExpanded / setPadKind). Each setter both rewrites the in-memory record
 * AND calls its own `saveX` -> `writeStorage`, so under pre-pollution (e.g. a
 * prior run left termWrap=true) a `beforeEach` reset to false persists "0" to
 * the raw storage key. That would leak the reset beyond this test.
 *
 * The daemon-scoped per-pane maps are handled separately by
 * `preferences-daemon-restore.ts`. This helper covers the simple scalar fields,
 * mirroring the same split: capture the raw storage preimage (`localStorage`) and
 * the canonical in-memory value (the read selector) together, then `restore()`
 * puts canonical back via the owned setters and the raw key back byte-exactly
 * (setItem/removeItem) AFTER the setters so a setter's own re-persist cannot
 * clobber it. Foreign keys/subscribers are left untouched; it is not a broad
 * `resetPreferences()`.
 */
export class ScalarPreferenceState {
  private raws: { wrap: string | null; defaultComposeLive: string | null; keysExpanded: string | null; padKind: string | null };
  private canonicals: { wrap: boolean; defaultComposeLive: boolean; keysExpanded: boolean; padKind: ReturnType<typeof padKind> };
  private captured = false;

  constructor() {
    this.raws = { wrap: null, defaultComposeLive: null, keysExpanded: null, padKind: null };
    this.canonicals = { wrap: false, defaultComposeLive: false, keysExpanded: false, padKind: "keys" };
  }

  /** Call once before any `set*` reset so the pre-images are the polluted ones. */
  capture(): void {
    this.raws = {
      wrap: localStorage.getItem(TERM_WRAP_KEY),
      defaultComposeLive: localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY),
      keysExpanded: localStorage.getItem(KEYS_EXPANDED_KEY),
      padKind: localStorage.getItem(PAD_KIND_KEY),
    };
    this.canonicals = {
      wrap: termWrap(),
      defaultComposeLive: defaultComposeLive(),
      keysExpanded: keysExpanded(),
      padKind: padKind(),
    };
    this.captured = true;
  }

  /** Restore canonical (in-memory) and raw (storage) pre-images, raw last. */
  restore(): void {
    if (!this.captured) return;
    const real = globalThis.localStorage;
    // Canonical first: the owned setters re-derive the raw from the record.
    setTermWrap(this.canonicals.wrap);
    setDefaultComposeLive(this.canonicals.defaultComposeLive);
    setKeysExpanded(this.canonicals.keysExpanded);
    setPadKind(this.canonicals.padKind);
    // Then the exact raw preimages, so a setter's re-persist cannot win.
    applyRaw(real, TERM_WRAP_KEY, this.raws.wrap);
    applyRaw(real, DEFAULT_COMPOSE_LIVE_KEY, this.raws.defaultComposeLive);
    applyRaw(real, KEYS_EXPANDED_KEY, this.raws.keysExpanded);
    applyRaw(real, PAD_KIND_KEY, this.raws.padKind);
  }
}

function applyRaw(real: Storage, key: string, raw: string | null): void {
  if (raw === null) real.removeItem(key);
  else real.setItem(key, raw);
}