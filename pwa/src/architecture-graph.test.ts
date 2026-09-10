import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLayer, dependencyIds, exportedNames, importSpecifiers, productionModules, reachable,
  type LayerPolicy,
} from "../test-support/module-graph";

/**
 * The architecture guard is a gate, so it gets its own positive and negative
 * fixtures. These cases run the same `auditLayer` policy engine that
 * `architecture-boundaries.test.ts` applies to `src/`, which is what makes a
 * green layer result evidence rather than an always-passing wrapper.
 */
const fixtures = fileURLToPath(new URL("../test-support/architecture-fixtures", import.meta.url));
const scenario = (name: string): string => resolve(fixtures, name);

const sharedPolicy: LayerPolicy = {
  name: "fixture/shared",
  root: "shared",
  allowedRoots: ["shared/"],
  allowedModules: ["lib/i18n", "lib/dictionary"],
  prohibitedModules: ["state", "paint", "live-operations"],
  prohibitedRoots: ["ui/", "pages/", "app/"],
};

const operationsPolicy: LayerPolicy = {
  name: "fixture/features/operations",
  root: "features/operations",
  allowedRoots: ["features/operations/", "shared/", "lib/"],
  allowedModules: [],
  prohibitedModules: ["state", "paint", "live-operations"],
  prohibitedRoots: ["ui/", "pages/", "app/"],
};

describe("module graph extraction", () => {
  test("a valid support chain stays inside the allowlist and never scans unreached files", () => {
    const root = scenario("clean");
    const report = auditLayer(root, sharedPolicy);
    expect(report.modules).toBe(1);
    expect(report.direct).toEqual([]);
    expect(report.transitive).toEqual([]);
    expect(report.prohibited).toEqual([]);
    // The support chain is followed; the prohibited module sitting in the same
    // tree is not, because nothing reaches it.
    const ids = reachable(root, productionModules(root, "shared")).ids;
    expect([...ids].sort()).toEqual(["lib/dictionary", "lib/i18n", "shared/surface"]);
  });

  test("a direct prohibited import is reported as both a direct and a transitive edge", () => {
    const report = auditLayer(scenario("direct-leak"), sharedPolicy);
    expect(report.direct).toEqual(["shared/surface -> state"]);
    expect(report.transitive).toEqual(["shared/surface -> state"]);
    expect(report.prohibited).toEqual(["[state] shared/surface -> state"]);
  });

  test("a prohibited module behind an allowed library re-export is reported with its whole path", () => {
    const root = scenario("reexport-leak");
    // The whitelist permits every lib module, so a single-hop scan is blind here.
    expect(dependencyIds(root, resolve(root, "features/operations/surface.ts"))).toEqual(["lib/bridge"]);
    const report = auditLayer(root, operationsPolicy);
    expect(report.direct).toEqual([]);
    expect(report.transitive).toEqual(["features/operations/surface -> lib/bridge -> live-operations"]);
    expect(report.prohibited).toEqual(["[live-operations] features/operations/surface -> lib/bridge -> live-operations"]);
  });

  test("comments and ordinary text are not module dependencies", () => {
    const root = scenario("decoy");
    const surface = resolve(root, "shared/surface.ts");
    expect(importSpecifiers(surface)).toEqual([]);
    expect(dependencyIds(root, surface)).toEqual([]);
    const report = auditLayer(root, sharedPolicy);
    expect(report.direct).toEqual([]);
    expect(report.transitive).toEqual([]);
    expect(report.prohibited).toEqual([]);
  });

  test("a literal dynamic import is a real edge in both directions", () => {
    const leak = auditLayer(scenario("dynamic-leak"), sharedPolicy);
    expect(leak.transitive).toEqual(["shared/surface -> state"]);
    expect(leak.prohibited).toEqual(["[state] shared/surface -> state"]);
    const clean = auditLayer(scenario("dynamic-clean"), sharedPolicy);
    expect(clean.transitive).toEqual([]);
    expect(clean.prohibited).toEqual([]);
  });

  test("a backtick dynamic import and a type-position import are the same kind of edge", () => {
    // `await import(`../state`)` has no interpolation, so it resolves statically.
    const templated = auditLayer(scenario("template-import"), sharedPolicy);
    expect(templated.transitive).toEqual(["shared/surface -> state"]);
    expect(templated.prohibited).toEqual(["[state] shared/surface -> state"]);
    // `type Phase = import("../state").State["phase"]` is a dependency too: an
    // ordinary `import type` already counted, so this form must not be exempt.
    const typePosition = auditLayer(scenario("import-type"), sharedPolicy);
    expect(typePosition.transitive).toEqual(["shared/surface -> state"]);
    expect(typePosition.prohibited).toEqual(["[state] shared/surface -> state"]);
  });

  test("an import cycle terminates and reports each participant once", () => {
    const root = scenario("cycle");
    const ids = reachable(root, productionModules(root, "shared")).ids;
    expect([...ids].sort()).toEqual(["shared/a", "shared/b"]);
    const report = auditLayer(root, sharedPolicy);
    expect(report.modules).toBe(2);
    expect(report.transitive).toEqual([]);
  });

  test("exported names come from declarations, not from source text", () => {
    const names = exportedNames(resolve(scenario("exports"), "facade.ts"));
    expect(names.declared).toEqual(["Connected", "ConnectedValue"]);
    expect(names.reexported).toEqual(["Button", "EmptySpec", "Feedback"]);
    expect(names.starReexports).toEqual([]);
  });

  test("a bare export clause declares a local name instead of forwarding it", () => {
    // `function Button()` plus `export { Button }` is an implementation living in
    // this file. Classifying it as re-exported would let a duplicate component
    // past a guard that only checks the re-export list.
    const names = exportedNames(resolve(scenario("exports"), "local-export.ts"));
    expect(names.declared).toEqual(["Button", "Feedback"]);
    expect(names.reexported).toEqual(["EmptySpec"]);
    expect(names.starReexports).toEqual([]);
  });

  test("an imported binding exported under an alias is a re-export, not a local implementation", () => {
    // `import { Button as Imported } ...; export { Imported as Button }` forwards
    // the other module's component. Calling this `declared` would report a
    // legitimate facade as a duplicate implementation.
    const names = exportedNames(resolve(scenario("exports"), "imported-alias.ts"));
    expect(names.declared).toEqual(["Local", "LocalConst"]);
    expect(names.reexported).toEqual(["Button", "FeedbackView"]);
    expect(names.starReexports).toEqual([]);
  });

  test("default and namespace import aliases are re-exports too", () => {
    const names = exportedNames(resolve(scenario("exports"), "namespace-alias.ts"));
    expect(names.declared).toEqual([]);
    expect(names.reexported).toEqual(["Def", "primitives"]);
    expect(names.starReexports).toEqual([]);
  });

  test("a star re-export is reported as unenumerable rather than silently dropped", () => {
    const names = exportedNames(resolve(scenario("exports"), "star.ts"));
    expect(names.declared).toEqual([]);
    expect(names.reexported).toEqual(["Connected"]);
    expect(names.starReexports).toEqual(["./shared-primitives"]);
  });
});
