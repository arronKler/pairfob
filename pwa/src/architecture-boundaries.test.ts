import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditLayer, dependencyIds, exportedNames, importSpecifiers, moduleId, productionModules, type LayerPolicy } from "../test-support/module-graph";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Layer contract for the directories this refactor introduced.
 *
 * The allowlist is the whole rule: a layer violates it by reaching anything
 * outside, whether through a direct import or through an allowed library that
 * re-exports application state. `auditLayer` resolves that transitively with the
 * project's own module resolution, so a facade cannot smuggle `state` in. The
 * prohibited lists add no restriction; they name the application module in the
 * failure instead of only saying "not allowed".
 *
 * `architecture-graph.test.ts` proves this engine catches a direct leak, a
 * re-export leak, a dynamic-import leak, an import cycle, and ignores comments
 * and strings that merely mention an import.
 */

/** Application controllers no page or feature may reach, even indirectly. */
const controllerModules = [
  "live", "live-operations", "live-settings", "live-state", "live-polling",
  "mutations", "notifications", "workspace", "computers", "computer-sessions",
  "pairing", "daemon-update", "main", "poll",
];

/** Everything below a page: the controllers plus global state and the paint loop. */
const applicationModules = [
  "state", "state-notices", "state-drafts", "paint", "viewport",
  "compose-drafts", ...controllerModules,
];

const layers: LayerPolicy[] = [
  {
    // Pure primitives plus the modal/action-sheet lifetime. `lib/i18n` and its
    // copy tables are the only application modules it may read: leaves that
    // import nothing but each other, with no state, paint or DOM root.
    name: "shared",
    root: "shared",
    allowedRoots: ["shared/"],
    allowedModules: ["lib/i18n", "lib/i18n-en", "lib/i18n-zh",
      "lib/i18n-en-workspace", "lib/i18n-zh-workspace"],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/", "features/", "lib/protocol/"],
  },
  {
    // Mutation operation forms and worktree progress. May use shared UI and the
    // protocol/operation libraries, never global state, a screen or a page.
    // The run/owner adapters and the operations controller are the feature's
    // declared connected adapters (they reach the domain layer and ui/).
    name: "features/operations",
    root: "features/operations",
    allowedRoots: ["features/operations/", "shared/", "lib/"],
    allowedModules: [],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: ["features/operations/controller", "features/operations/owner", "features/operations/run"],
  },
  {
    // Quota model, snapshot store and views. `actions.ts` is the feature's one
    // connected adapter: it reads the legacy facade and owns the in-flight and
    // stale-session guards, so nothing else here has to.
    name: "features/agent-quota",
    root: "features/agent-quota",
    allowedRoots: ["features/agent-quota/", "shared/", "lib/"],
    // The domain store primitive lives in shared/model (under the allowed shared
    // root), so the feature adopts the detach/freeze contract instead of
    // hand-rolling one. Nothing under app/ is reachable.
    allowedModules: [],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: ["features/agent-quota/actions"],
  },
  {
    // Runtime-status model. `runtime-status.ts` is the connected adapter that
    // reads the current session; the model takes explicit inputs. The
    // connection controllers (lifecycle, observation, openPane, controller,
    // mutations, retirement and runtime) are declared connected adapters in the
    // exclusion list: they take ports from the composition root and reach the
    // domain layer. The one cross-feature OWNER edge the connection owner has
    // (`connection-store` drafts the pairing code) is pinned to its exact module;
    // the owner's own dependencies are audited by `domain-owners.test.ts`.
    name: "features/connection",
    root: "features/connection",
    allowedRoots: ["features/connection/", "shared/", "lib/"],
    allowedModules: ["features/pairing/form-store"],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: [
      "features/connection/controller",
      "features/connection/generations",
      "features/connection/lifecycle",
      "features/connection/mutations",
      "features/connection/open-pane",
      "features/connection/retirement",
      "features/connection/retirement-owner",
      "features/connection/runtime",
      "features/connection/runtime-status",
      "features/connection/session-events",
      "features/connection/snapshot",
    ],
  },
  {
    // A page composes features and shared UI, and reads the core domain layer.
    // The domain layer is declared opaque because its internal boundaries are
    // core's own audited responsibility.
    name: "pages/quota",
    root: "pages/quota",
    allowedRoots: ["pages/quota/", "features/", "shared/", "lib/", "app/"],
    allowedModules: [],
    prohibitedModules: controllerModules,
    prohibitedRoots: ["ui/"],
    opaque: ["app/"],
  },
  {
    // Computer catalog projection, session pool and list view. `actions.ts` is
    // the feature's one connected adapter: resume/switch/forget talk to live.
    name: "features/computers",
    root: "features/computers",
    allowedRoots: ["features/computers/", "shared/", "lib/"],
    allowedModules: [],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: ["features/computers/actions"],
  },
  {
    // Computers picker. Opaque seams are the domain layer, live/state reached
    // through the computers controller, and the two chrome entries that have
    // not yet moved to their owners.
    name: "pages/computers",
    root: "pages/computers",
    allowedRoots: ["pages/computers/", "features/", "shared/", "lib/", "app/"],
    allowedModules: [
      "compose-drafts", "viewport", "ui/react/chrome",
      // Reached through the computers controller: resume/switch/forget still call
      // live, and a few pairing-input fields still have no live-record helper.
      "live", "state",
    ],
    prohibitedModules: controllerModules,
    prohibitedRoots: ["ui/"],
    opaque: ["app/", "live", "state", "compose-drafts", "viewport", "ui/react/chrome"],
  },
  {
    // Pairing projection and connect form. `actions.ts` owns the handshake.
    name: "features/pairing",
    root: "features/pairing",
    allowedRoots: ["features/pairing/", "shared/", "lib/"],
    allowedModules: [],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: ["features/pairing/actions"],
  },
  {
    name: "pages/connect",
    root: "pages/connect",
    allowedRoots: ["pages/connect/", "features/", "shared/", "lib/", "app/"],
    allowedModules: [
      "viewport", "ui/react/chrome", "live", "state", "compose-drafts",
    ],
    prohibitedModules: controllerModules,
    prohibitedRoots: ["ui/"],
    opaque: ["app/", "live", "state", "viewport", "ui/react/chrome", "compose-drafts"],
  },
  {
    name: "features/settings",
    root: "features/settings",
    allowedRoots: ["features/settings/", "shared/", "lib/"],
    // `preferences-store` is the settings domain owner; its one cross-feature
    // OWNER edge (storage keys are scoped by the connected computer) is pinned
    // to the exact catalog owner module and cross-audited by domain-owners.test.
    allowedModules: ["features/computers/catalog-store"],
    prohibitedModules: applicationModules,
    prohibitedRoots: ["ui/", "pages/", "app/"],
    exclude: [
      "features/settings/actions",
      "features/settings/daemon-update",
      "features/settings/daemon-update-view",
      "features/settings/language",
      "features/settings/notifications",
    ],
  },
  {
    name: "pages/settings",
    root: "pages/settings",
    allowedRoots: ["pages/settings/", "pages/quota/", "features/", "shared/", "lib/", "app/"],
    allowedModules: [
      "compose-drafts", "viewport", "ui/react/chrome", "live", "state",
      "live-operations", "mutations",
    ],
    prohibitedModules: controllerModules,
    prohibitedRoots: ["ui/"],
    opaque: [
      "app/", "live", "state", "compose-drafts", "viewport", "ui/react/chrome",
      "live-operations", "mutations",
    ],
  },
];

/**
 * The temporary adapter seam a page still touches. It is asserted so it can only
 * shrink: with the declarative <App/> root in place a page navigates with a
 * domain action and composes declaratively, so this list is empty.
 */
const LEGACY_PAGE_ADAPTER: string[] = [];

describe("architecture layer boundaries", () => {
  for (const policy of layers) {
    test(`${policy.name}/ reaches nothing outside its allowlist, directly or transitively`, () => {
      const report = auditLayer(sourceRoot, policy);
      expect(report.modules).toBeGreaterThan(0);
      expect(report.direct).toEqual([]);
      expect(report.transitive).toEqual([]);
      expect(report.prohibited).toEqual([]);
    });
  }

  test("shared UI resolves press feedback and motion inside shared", () => {
    // `state.ts` re-exports `haptic` from `lib/dom`; importing it through state
    // was the only edge tying the long-press gesture to global app state.
    const gesture = dependencyIds(sourceRoot, resolve(sourceRoot, "shared/ui/overlay/object-press.ts"));
    expect(gesture).toContain("shared/ui/dom/feedback");
    const drag = dependencyIds(sourceRoot, resolve(sourceRoot, "shared/ui/overlay/sheet-drag.ts"));
    expect(drag).toContain("shared/ui/dom/feedback");
    expect(drag).toContain("shared/ui/dom/motion");
  });

  /**
   * The exclusions above are a claim, so it gets checked: these must be exactly
   * the files in each feature that reach application state or the paint loop.
   * A new connected file inside a feature fails here until it is declared.
   */
  test("each feature names exactly the connected adapters it excludes", () => {
    /**
     * The real domain owner modules (M1). Domain ownership lives here by exact
     * path — never by a `-store` suffix or a blanket feature exemption; the
     * owner-to-owner edges are pinned independently in `domain-owners.test.ts`.
     */
    const DOMAIN_OWNERS = new Set([
      "features/connection/connection-store", "features/connection/runtime-store",
      "features/computers/catalog-store", "features/pairing/form-store",
      "features/dashboard/catalog-store", "features/board/layout-store",
      "features/settings/preferences-store", "features/session/session-store",
      "features/session/compose-store", "features/session/chat/trace-store",
      "features/operations/capabilities-store", "app/navigation-store", "app/notices-store",
    ]);
    const legacyEdge = (dep: string) => dep === "state" || dep === "paint" || dep === "compose-drafts";
    /**
     * A presentation/adapter file is connected if it reaches the legacy facade,
     * the paint loop, or a domain OWNER owned by ANOTHER feature (a component
     * reading its own feature's store is normal, not connected). The domain
     * owner modules themselves are excluded from this list — their own
     * dependencies are audited by `domain-owners.test.ts`.
     */
    function connectedAdapters(sub: string): string[] {
      const reachesEdge = (dep: string) =>
        legacyEdge(dep) || dep === "app/domain-publication"
        // Draft coordination keeps this boundary after moving to its feature owner.
        || dep === "features/session/drafts/compose-drafts"
        || (DOMAIN_OWNERS.has(dep) && !dep.startsWith(`${sub}/`));
      return productionModules(sourceRoot, sub)
        .filter((file) => {
          if (DOMAIN_OWNERS.has(moduleId(sourceRoot, file))) return false;
          return dependencyIds(sourceRoot, file).some(reachesEdge);
        })
        .map(file => moduleId(sourceRoot, file))
        .sort();
    }
    expect(connectedAdapters("features/operations")).toEqual([
      "features/operations/controller",
      "features/operations/owner",
      "features/operations/run",
    ]);
    expect(connectedAdapters("features/agent-quota")).toEqual(["features/agent-quota/actions"]);
    expect(connectedAdapters("features/connection")).toEqual([
      "features/connection/controller",
      "features/connection/generations",
      "features/connection/lifecycle",
      "features/connection/mutations",
      "features/connection/open-pane",
      "features/connection/retirement",
      "features/connection/retirement-owner",
      "features/connection/runtime",
      "features/connection/runtime-status",
      "features/connection/session-events",
      "features/connection/snapshot",
    ]);
    expect(connectedAdapters("features/computers")).toEqual(["features/computers/actions"]);
    expect(connectedAdapters("features/pairing")).toEqual(["features/pairing/actions"]);
    expect(connectedAdapters("features/settings")).toEqual([
      "features/settings/actions",
      "features/settings/daemon-update",
      "features/settings/daemon-update-view",
      "features/settings/language",
      "features/settings/notifications",
    ]);
  });

  test("a page touches the retired legacy paint adapter only where it declares", () => {
    const quota = layers.find(layer => layer.name === "pages/quota");
    expect(quota?.opaque?.slice().sort()).toEqual(["app/"]);
    expect(quota?.allowedModules).toEqual(LEGACY_PAGE_ADAPTER);
    // Name every page file that still reaches the retired paint adapter directly.
    // dependencyIds drops unresolved targets (module-graph 96-116), so a page
    // importing the now-deleted ../../paint would vanish from that list. Check the
    // raw literal import specifiers and normalize the relative target to the
    // src-relative id even when the payer file is missing, so a reintroduced
    // (or a dangling) paint import is rejected instead of the assertion passing.
    const reachesPaint = (file: string): boolean =>
      importSpecifiers(file).some((specifier) => {
        if (!specifier.startsWith(".")) return false;
        const target = resolve(dirname(file), specifier).replace(/\.[jt]sx?$/, "");
        return moduleId(sourceRoot, target) === "paint";
      });
    const readers = ["pages/quota", "pages/computers", "pages/connect", "pages/settings"].flatMap(sub => productionModules(sourceRoot, sub)
      .filter(file => reachesPaint(file) || dependencyIds(sourceRoot, file).some(dep => dep === "paint"))
      .map(file => moduleId(sourceRoot, file)))
      .sort();
    expect(readers).toEqual([]);
  });
});
