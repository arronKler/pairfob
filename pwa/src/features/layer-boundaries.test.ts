/**
 * Layer boundaries for the dashboard and board slice.
 *
 * The point of the split is that presentation and pure models cannot reach the
 * global application record: only a page bridge may. These rules pin that, and
 * pin the temporary edges (shared chrome primitives still moving to `shared/ui`,
 * the list menu joining this batch next) so nothing new sneaks in and every
 * remaining legacy import is one a reviewer can see.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preProcessFile } from "typescript";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

const FEATURE_DIRS = ["features/dashboard", "features/board", "features/connection"];

/**
 * Owned page modules, listed explicitly. `pages/` is shared ground — other
 * authors add their own routes there — so this guard scans exactly the dashboard
 * and board routes plus the two page helpers they share, and fails if one is
 * renamed instead of silently passing on somebody else's files.
 */
const PAGE_MODULES = [
  "pages/board/board-bridge.ts",
  "pages/board/index.tsx",
  "pages/board/pane-scroll.ts",
  "pages/domain-updates.ts",
  "pages/home/herd-bridge.ts",
  "pages/home/index.tsx",
  "pages/home/object-menu.ts",
];

/** Global record + repaint loop. Nothing below a page bridge may import these. */
const GLOBAL_RECORD = new Set(["state.ts", "paint.ts"]);

/**
 * The page bridge that performs a real navigation. Entering and leaving the
 * board changes `#app` classes, the document scroll lock and the terminal CSS
 * variables, so it commits the arriving shell synchronously through the existing
 * controller boundary `app/host.commitView` — never the legacy paint loop.
 */
const NAV_COMMIT_SEAM = "pages/board/board-bridge.ts";

/**
 * The only legacy `ui/` edges left in this slice: the connected chrome that has
 * no feature owner yet (the app notice and the herd banners) and the daemon
 * update banner, which belongs to another slice. Everything else is the approved
 * `shared/ui` surface or a sibling feature.
 */
const TEMPORARY_UI_EDGES = new Set<string>([]);

/** Directories a pure model must never reach: they render, measure or mutate. */
const IMPURE_DIRS = ["ui/", "pages/", "components/", "canvas/", "rail/", "shared/", "app/"];

function relative(file: string): string {
  return file.slice(srcRoot.length).replace(/^\/+/, "");
}

function ownedPageModules(): string[] {
  return PAGE_MODULES.map((path) => {
    const file = resolve(srcRoot, path);
    // A renamed or deleted module must fail here, not vanish from the scan.
    readFileSync(file);
    return file;
  });
}

function productionModules(dirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const root = resolve(srcRoot, dir);
    for (const found of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root, onlyFiles: true })) {
      const file = join(root, found);
      if (/\.test\.tsx?$/.test(file)) continue;
      files.push(file);
    }
  }
  return files.sort();
}

function localImports(file: string): string[] {
  const imports = preProcessFile(readFileSync(file, "utf8")).importedFiles;
  return imports.flatMap(({ fileName }) => {
    if (!fileName.startsWith(".")) return [];
    const base = resolve(dirname(file), fileName);
    const resolved = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
      .find((candidate) => {
        try {
          readFileSync(candidate);
          return true;
        } catch {
          return false;
        }
      });
    return resolved ? [relative(resolved)] : [fileName];
  });
}

function bareImports(file: string): string[] {
  return preProcessFile(readFileSync(file, "utf8")).importedFiles
    .map(({ fileName }) => fileName)
    .filter((fileName) => !fileName.startsWith("."));
}

function modelModules(): string[] {
  return productionModules(FEATURE_DIRS).filter((file) => {
    const path = relative(file);
    return path.includes("/model/") || /preview\/(model|store)\.ts$/.test(path);
  });
}

describe("dashboard and board layer boundaries", () => {
  test("every owned module was scanned, so the rules cannot silently pass on nothing", () => {
    const features = productionModules(FEATURE_DIRS);
    const pages = ownedPageModules();
    expect(features.length).toBeGreaterThan(12);
    expect(pages).toHaveLength(PAGE_MODULES.length);
    expect(modelModules().length).toBeGreaterThan(4);
    expect(pages.map(relative)).toEqual([...PAGE_MODULES].sort());
  });

  test("feature presentation and models never read the global record or a page bridge", () => {
    const offenders = productionModules(FEATURE_DIRS).flatMap((file) =>
      localImports(file)
        .filter((target) => GLOBAL_RECORD.has(target) || target.startsWith("pages/"))
        .map((target) => `${relative(file)} -> ${target}`),
    );
    expect(offenders).toEqual([]);
  });

  test("no module reads the legacy record or repaint loop; board navigation uses the host commit", () => {
    const seams: string[] = [];
    for (const file of [...productionModules(FEATURE_DIRS), ...ownedPageModules()]) {
      for (const target of localImports(file)) {
        if (target === "state.ts") throw new Error(`${relative(file)} imports the legacy record`);
        if (target === "paint.ts") seams.push(relative(file));
      }
    }
    // The bridges publish through domains and the App commit pipeline; nothing in
    // this slice asks the legacy paint loop for a repaint any more.
    expect(seams).toEqual([]);
    // Entering and leaving the board still needs the arriving shell synchronously;
    // that goes through the approved controller commit boundary.
    expect(localImports(resolve(srcRoot, NAV_COMMIT_SEAM))).toContain("app/host.ts");
    for (const route of ["pages/home/index.tsx", "pages/board/index.tsx"]) {
      expect(localImports(resolve(srcRoot, route)).filter((target) => GLOBAL_RECORD.has(target))).toEqual([]);
    }
  });

  test("pure models import no React and nothing that renders, measures or mutates", () => {
    const offenders = modelModules().flatMap((file) => {
      const react = bareImports(file).filter((name) => name === "react" || name === "react-dom");
      const impure = localImports(file).filter((target) => IMPURE_DIRS.some((dir) => target.startsWith(dir)));
      return [...react, ...impure].map((target) => `${relative(file)} -> ${target}`);
    });
    expect(offenders).toEqual([]);
  });

  test("the remaining legacy ui/ edges in features are exactly the recorded temporary ones", () => {
    // Page bridges are the binding layer: they may call any app service.
    const edges = new Set<string>();
    for (const file of productionModules(FEATURE_DIRS)) {
      for (const target of localImports(file)) {
        if (target.startsWith("ui/")) edges.add(target);
      }
    }
    const unrecorded = [...edges].filter((edge) => !TEMPORARY_UI_EDGES.has(edge)).sort();
    expect(unrecorded).toEqual([]);
    // Recorded edges that already retired should be dropped from the allowlist.
    expect([...edges].sort()).toEqual([]);
  });
});
