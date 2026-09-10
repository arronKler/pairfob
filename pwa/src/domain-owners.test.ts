import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyIds, exportedNames, importSpecifiers, moduleId, productionModules } from "../test-support/module-graph";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Domain owner manifest (M1).
 *
 * This is the authoritative, explicit list of domain model owners. A domain
 * store is matched by being on this list — never by a `-store` filename suffix or
 * a blanket `features/` exemption. The map pins the cross-OWNER dependencies that
 * already exist as business contracts (e.g. dashboard folding a snapshot also
 * prunes per-pane preferences). Those reads/writes are preserved; a NEW
 * undocumented owner-to-owner edge fails here.
 */
const OWNERS: Record<string, readonly string[]> = {
  "features/connection/connection-store": ["features/pairing/form-store"],
  "features/connection/runtime-store": [],
  "features/computers/catalog-store": [],
  "features/pairing/form-store": [],
  "features/dashboard/catalog-store": [
    "features/board/layout-store",
    "features/computers/catalog-store",
    "features/session/session-store",
    "features/settings/preferences-store",
  ],
  "features/board/layout-store": [],
  "features/settings/preferences-store": ["features/computers/catalog-store"],
  "features/session/session-store": [
    "features/session/chat/trace-store",
    "features/session/compose-store",
  ],
  "features/session/compose-store": ["features/settings/preferences-store"],
  "features/session/chat/trace-store": [],
  "features/operations/capabilities-store": [],
  // App-owned coordination domains.
  "app/navigation-store": ["features/board/layout-store"],
  "app/notices-store": [
    "app/navigation-store",
    "features/computers/catalog-store",
    "features/connection/connection-store",
    "features/session/session-store",
  ],
};

const OWNER_IDS = Object.keys(OWNERS);

/** Framework-neutral primitives, imported by every owner. */
const SHARED_MODEL = "shared/model/";
const SHARED_REACT = "shared/react/";

/** Read-only protocol/presentation libraries a domain model may import. */
const LIB = "lib/";

function deps(id: string): string[] {
  return dependencyIds(sourceRoot, resolve(sourceRoot, `${id}.ts`));
}

/**
 * Framework-runtime imports detected from the syntax tree (not a quote-sensitive
 * string scan). `dependencyIds` only follows local modules, so it cannot see the
 * external `react` package; this reads every static import, dynamic import and
 * re-export specifier and matches `react`, `react-dom` and their subpaths
 * (`react-dom/client`, `react/jsx-runtime`, …) regardless of quote style.
 */
function reactSpecs(id: string): string[] {
  return importSpecifiers(resolve(sourceRoot, `${id}.ts`)).filter((spec) =>
    spec === "react" || spec === "react-dom" || spec.startsWith("react/") || spec.startsWith("react-dom/"));
}

describe("domain owner manifest", () => {
  test("every declared owner exists and is one exact module", () => {
    expect(OWNER_IDS).toHaveLength(13);
    for (const id of OWNER_IDS) {
      readFileSync(resolve(sourceRoot, `${id}.ts`)); // a renamed owner must fail
      expect(id).toMatch(/-(store)$|^app\/(navigation|notices)-store$/);
    }
  });

  test("an owner reaches only its declared cross-owner dependencies (no hidden coupling)", () => {
    for (const id of OWNER_IDS) {
      const allowed = new Set(OWNERS[id]);
      const actual = deps(id).filter((dep) => OWNER_IDS.includes(dep)).sort();
      expect(actual).toEqual([...allowed].sort());
    }
  });

  test("owners import only the shared model primitive, read-only libs and (App) the transition", () => {
    for (const id of OWNER_IDS) {
      const isAppOwner = id.startsWith("app/");
      for (const dep of deps(id)) {
        if (OWNER_IDS.includes(dep)) continue; // pinned above
        const ok =
          dep.startsWith(SHARED_MODEL) ||
          dep.startsWith(LIB) ||
          dep === "features/board/model/snapshot-state" ||
          (isAppOwner && dep === "app/transition");
        expect(ok, `${id} -> ${dep}`).toBe(true);
      }
    }
  });

  test("feature owners never import the App composition/runtime, React, UI, pages or screens", () => {
    for (const id of OWNER_IDS.filter((o) => o.startsWith("features/"))) {
      for (const dep of deps(id)) {
        const banned =
          dep.startsWith("app/") ||
          dep.startsWith("ui/") ||
          dep.startsWith("pages/") ||
          dep.startsWith("features/screen");
        expect(banned, `${id} -> ${dep}`).toBe(false);
      }
      expect(reactSpecs(id), `${id} must not import React/ReactDOM`).toEqual([]);
    }
  });

  test("App owners coordinate feature stores but never render or import a page/screen", () => {
    for (const id of ["app/navigation-store", "app/notices-store"]) {
      for (const dep of deps(id)) {
        const banned = dep.startsWith("ui/") || dep.startsWith("pages/");
        expect(banned, `${id} -> ${dep}`).toBe(false);
      }
      expect(reactSpecs(id), `${id} must not import React/ReactDOM`).toEqual([]);
    }
  });

  test("the generic shared model primitives are framework-neutral (no React, no app graph)", () => {
    for (const id of [
      "shared/model/domain-store",
      "shared/model/domain-environment",
      "shared/model/compose-transaction",
    ]) {
      const local = deps(id).filter((dep) => !dep.startsWith(SHARED_MODEL));
      expect(local, id).toEqual([]);
      expect(reactSpecs(id), `${id} must not import React/ReactDOM`).toEqual([]);
    }
  });
});

/**
 * The M1 compatibility shims (app/state/* leaf re-exports, app/store) are
 * deleted; consumers import the real owners directly. This guard asserts no
 * production module reaches back to an obsolete legacy facade path. It resolves
 * each relative import against the importer's directory to a canonical
 * sourceRoot-relative module id FIRST (deleted targets included), then rejects
 * the retired path — a plain text check on the raw specifier would miss
 * `./state/session`, `./store` and other relative forms.
 */
describe("no production consumer reaches a retired legacy facade path", () => {
  const RETIRED = new Set(["app/store", "app/state/board", "app/state/capabilities", "app/state/chat",
    "app/state/compose", "app/state/computers", "app/state/connection", "app/state/dashboard",
    "app/state/navigation", "app/state/notices", "app/state/pairing", "app/state/preferences",
    "app/state/runtime", "app/state/session"]);

  test("production modules never import app/store or app/state/* leaf aliases", () => {
    const files = productionModules(sourceRoot);
    // A non-empty scan proves the census below runs against the real tree rather
    // than quietly passing over nothing.
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec).replace(/\.[jt]sx?$/, "");
        const id = moduleId(sourceRoot, target);
        expect(RETIRED.has(id), `${moduleId(sourceRoot, file)} -> ${spec} (${id})`).toBe(false);
      }
    }
  });
});
