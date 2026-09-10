import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import "../../test-support/boot-dom";
import type { DomainEnvironment } from "../shared/model/domain-environment";

const pwaRoot = fileURLToPath(new URL("../..", import.meta.url));

const { hydrateApplicationState } = await import("./hydrate");
const { connectionStore, initialConnection, networkMode, networkOnline, setNetworkMode, setNetworkOnline } = await import("../features/connection/connection-store");
const { composeLive, composeStore, setComposeLive } = await import("../features/session/compose-store");
const { publishAllDomains } = await import("./domain-publication");
const {
  DEFAULT_COMPOSE_LIVE_KEY, DEFAULT_TERM_MODE_KEY, KEYS_EXPANDED_KEY, LIST_GROUP_KEY, PAD_KIND_KEY,
  TERM_COLS_KEY, TERM_FIT_KEY, TERM_WRAP_KEY,
  defaultComposeLive, defaultTermMode, initialPreferences, keysExpanded, listGroup, padKind, preferencesStore,
  setDefaultComposeLive, setDefaultTermMode, setKeysExpanded, setListGroup, setPadKind,
  setTermFontPx, setTermGrid, setTermWrap, termCols, termFit, termFontPx, termWrap,
} = await import("../features/settings/preferences-store");
const { NETWORK_MODE_KEY } = await import("../lib/network-mode");

// Named baseline capture and restore for the fields hydration owns. A state
// facade write cannot restore these: each restored value goes through its real
// owner setter, then the real pending-publication flush republishes once.
const before = {
  termFontPx: termFontPx(), termWrap: termWrap(), termFit: termFit(), termCols: termCols(),
  keysExpanded: keysExpanded(), padKind: padKind(), listGroup: listGroup(),
  defaultTermMode: defaultTermMode(), defaultComposeLive: defaultComposeLive(),
  composeLive: composeLive(),
  networkOnline: networkOnline(),
  networkMode: networkMode(),
};

// The persisted preference setters below also write their raw storage keys. The
// original flat restore was non-persistent, so the pure baseline left every
// affected key null. Capture the exact raw preimages before fixture mutation and
// restore them AFTER the canonical setters, so raw storage returns to its exact
// pre-mutation state without touching foreign keys (no storage.clear / global
// reset). This keeps the canonical/raw divergence honest.
const RAW_KEYS = [
  TERM_WRAP_KEY, TERM_FIT_KEY, TERM_COLS_KEY, KEYS_EXPANDED_KEY, PAD_KIND_KEY,
  LIST_GROUP_KEY, DEFAULT_TERM_MODE_KEY, DEFAULT_COMPOSE_LIVE_KEY, NETWORK_MODE_KEY,
] as const;
const rawBefore = Object.fromEntries(RAW_KEYS.map((key) => [key, localStorage.getItem(key)])) as
  Record<(typeof RAW_KEYS)[number], string | null>;

afterEach(() => {
  setTermFontPx(before.termFontPx);
  setTermWrap(before.termWrap);
  setTermGrid(before.termFit, before.termCols);
  setKeysExpanded(before.keysExpanded);
  setPadKind(before.padKind);
  setListGroup(before.listGroup);
  setDefaultTermMode(before.defaultTermMode);
  setDefaultComposeLive(before.defaultComposeLive);
  setComposeLive(before.composeLive);
  setNetworkOnline(before.networkOnline);
  setNetworkMode(before.networkMode);
  publishAllDomains();
  // Raw storage last: the canonical restore already fixed the record; now return
  // each affected key to its exact pre-mutation raw value (null => absent).
  for (const key of RAW_KEYS) {
    const preimage = rawBefore[key];
    if (preimage === null) localStorage.removeItem(key);
    else localStorage.setItem(key, preimage);
  }
});

function environment(stored: Record<string, string>, overrides: Partial<DomainEnvironment> = {}): DomainEnvironment {
  return { read: (key) => stored[key] ?? null, online: true, desk: false, ...overrides };
}

describe("domain models import without a browser", () => {
  test("a fresh process with no browser globals can import every state module", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, "scripts/state-purity-probe.ts"],
      cwd: pwaRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(run.stdout);
    const report = JSON.parse(stdout) as { ok: boolean; checked: number; results: Array<{ module: string; ok: boolean; error?: string }> };
    expect(report.results.filter((entry) => !entry.ok)).toEqual([]);
    expect(report.ok).toBeTrue();
    expect(report.checked).toBeGreaterThanOrEqual(24);
    expect(run.exitCode).toBe(0);
  });

  test("model defaults are pure: no reachability guess, no responsive font, no storage", () => {
    expect(initialConnection().networkOnline).toBeTrue();
    expect(initialConnection().networkMode).toBe("auto");
    expect(initialPreferences().termFontPx).toBe(12);
    expect(initialPreferences().termWrap).toBeFalse();
    expect(initialPreferences().termFit).toBe("pan");
    expect(initialPreferences().termCols).toBe(80);
    expect(initialPreferences().listGroup).toBe("flat");
    expect(initialPreferences().defaultTermMode).toBe("auto");
    expect(initialPreferences().defaultComposeLive).toBeFalse();
    expect(initialPreferences().paneTermModes).toEqual({});
  });
});

describe("boot hydration", () => {
  test("stored choices and reachability are adopted once, as one transaction", () => {
    let notifications = 0;
    const releases = [
      preferencesStore.subscribe(() => { notifications += 1; }),
      connectionStore.subscribe(() => { notifications += 1; }),
      composeStore.subscribe(() => { notifications += 1; }),
    ];

    hydrateApplicationState(environment({
      "pairfob:termFont": "18",
      "pairfob:termWrap": "1",
      "pairfob:termFit": "fit",
      "pairfob:termCols": "120",
      "pairfob:keysExpanded": "1",
      "pairfob:padKind": "slash",
      "pairfob:listGroup": "space",
      "pairfob:defaultTermMode": "agent",
      "pairfob:defaultComposeLive": "1",
      "pairfob:networkMode": "relay",
    }, { online: false }));

    expect(preferencesStore.get().termFontPx).toBe(18);
    expect(preferencesStore.get().termWrap).toBeTrue();
    expect(preferencesStore.get().termFit).toBe("fit");
    expect(preferencesStore.get().termCols).toBe(120);
    expect(preferencesStore.get().keysExpanded).toBeTrue();
    expect(preferencesStore.get().padKind).toBe("slash");
    expect(preferencesStore.get().listGroup).toBe("space");
    expect(preferencesStore.get().defaultTermMode).toBe("agent");
    expect(preferencesStore.get().defaultComposeLive).toBeTrue();
    // The compose field follows the hydrated default, not a second storage read.
    expect(composeStore.get().composeLive).toBeTrue();
    expect(connectionStore.get().networkOnline).toBeFalse();
    expect(connectionStore.get().networkMode).toBe("relay");
    // One transaction: each hydrated domain published once, not once per field.
    expect(notifications).toBe(3);
    for (const release of releases) release();
  });

  test("the responsive terminal font follows the boot layout when nothing is stored", () => {
    hydrateApplicationState(environment({}, { desk: true }));
    expect(preferencesStore.get().termFontPx).toBe(13);
    expect(connectionStore.get().networkOnline).toBeTrue();
    expect(connectionStore.get().networkMode).toBe("auto");

    hydrateApplicationState(environment({}, { desk: false }));
    expect(preferencesStore.get().termFontPx).toBe(12);
  });

  test("blocked or malformed storage falls back to the shipped defaults", () => {
    hydrateApplicationState(environment({
      "pairfob:termFont": "not-a-number",
      "pairfob:termCols": "37",
      "pairfob:termFit": "sideways",
      "pairfob:listGroup": "[]",
      "pairfob:defaultTermMode": "turbo",
      "pairfob:networkMode": "carrier-pigeon",
    }));
    expect(preferencesStore.get().termFontPx).toBe(12);
    expect(preferencesStore.get().termCols).toBe(80);
    expect(preferencesStore.get().termFit).toBe("pan");
    expect(preferencesStore.get().listGroup).toBe("flat");
    expect(preferencesStore.get().defaultTermMode).toBe("auto");
    expect(connectionStore.get().networkMode).toBe("auto");
  });
});
