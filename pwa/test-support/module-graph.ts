import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";

/**
 * Local module graph extraction for architecture tests.
 *
 * Two rules make this trustworthy as a gate:
 *
 * 1. Edges come from the TypeScript syntax tree, never from a substring scan, so
 *    a comment or an ordinary string that mentions `import("./state")` is not a
 *    dependency, and a real one is counted exactly once.
 * 2. Reachability is transitive and resolved with the project's own module
 *    resolution (Bundler + allowImportingTsExtensions, matching tsconfig.json),
 *    so a layer that imports a library which re-exports a prohibited module is
 *    reported as reaching it — because at runtime it does.
 */

/** A module id is a root-relative, extension-free path with posix separators. */
export type ModuleId = string;

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

const resolutionHost: ts.ModuleResolutionHost = {
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  directoryExists: ts.sys.directoryExists,
  realpath: ts.sys.realpath,
};

/** Every production (non-test) module under `root/sub`, as sorted absolute paths. */
export function productionModules(root: string, sub = ""): string[] {
  const base = sub ? resolve(root, sub) : root;
  return [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: base, onlyFiles: true })]
    .filter(file => !/\.test\.tsx?$/.test(file))
    .map(file => resolve(base, file))
    .sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/**
 * The literal text of a module specifier.
 *
 * TypeScript types every module specifier as `Expression`, so this narrows to the
 * two forms that name a module statically. A template literal that interpolates
 * has no resolvable specifier and yields null rather than a guess.
 */
function specifierText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (node as ts.StringLiteral).text;
  }
  return null;
}

/**
 * The specifiers one file depends on, read from its syntax tree.
 * Covers static imports (including `import type`), `export ... from`, literal
 * dynamic `import()` written with either quote form, `import x = require(...)`
 * and type-position `import("...").T`. Bare specifiers (packages) are returned
 * too; callers filter with `resolveLocal`. A template literal that interpolates
 * has no statically resolvable specifier and is deliberately skipped.
 */
export function importSpecifiers(file: string): string[] {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = specifierText(node.moduleSpecifier);
      if (spec) found.push(spec);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = specifierText(node.arguments[0]);
      if (spec) found.push(spec);
    } else if (ts.isImportTypeNode(node)) {
      const spec = ts.isLiteralTypeNode(node.argument) ? specifierText(node.argument.literal) : null;
      if (spec) found.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = specifierText(node.moduleReference.expression);
      if (spec) found.push(spec);
    }
    node.forEachChild(visit);
  }
  visit(parse(file));
  return found;
}

/** Resolve one specifier to a real file under `root`, or null if it leaves the project. */
export function resolveLocal(root: string, fromFile: string, specifier: string): string | null {
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptions, resolutionHost).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport) return null;
  const file = resolved.resolvedFileName;
  if (file.endsWith(".d.ts")) return null;
  const inside = resolve(file).startsWith(root.endsWith(sep) ? root : root + sep);
  return inside ? file : null;
}

/** The module id for an absolute file: root-relative, posix separators, no extension. */
export function moduleId(root: string, file: string): ModuleId {
  return relative(root, file).split(sep).join("/").replace(/\.(ts|tsx)$/, "");
}

/** Direct local dependency ids of one file, deduplicated. */
export function dependencyIds(root: string, file: string): ModuleId[] {
  const ids = new Set<ModuleId>();
  for (const specifier of importSpecifiers(file)) {
    const target = resolveLocal(root, file, specifier);
    if (target) ids.add(moduleId(root, target));
  }
  return [...ids].sort();
}

export type Reach = {
  /** Every reachable module id, entries included. */
  ids: Set<ModuleId>;
  /** One shortest edge path per id, so a violation can be reported with its route. */
  pathTo(id: ModuleId): ModuleId[];
};

/**
 * Transitive closure over local dependencies. Test modules are not followed:
 * they are consumers of the graph, never part of a production layer. Ids matching
 * an `opaque` prefix are recorded as reached but not expanded.
 */
export function reachable(root: string, entryFiles: string[], opaque: Iterable<ModuleId> = []): Reach {
  const stopped = [...opaque];
  const opaqueHit = (id: ModuleId) => stopped.some(prefix => id === prefix || id.startsWith(prefix));
  const previous = new Map<ModuleId, ModuleId | null>();
  const queue: ModuleId[] = [];
  for (const file of entryFiles) {
    const id = moduleId(root, file);
    if (!previous.has(id)) {
      previous.set(id, null);
      queue.push(id);
    }
  }
  const fileOf = new Map<ModuleId, string>(entryFiles.map(file => [moduleId(root, file), file]));
  while (queue.length) {
    const id = queue.shift()!;
    if (opaqueHit(id)) continue;
    const file = fileOf.get(id);
    if (!file) continue;
    for (const specifier of importSpecifiers(file)) {
      const target = resolveLocal(root, file, specifier);
      if (!target || /\.test\.tsx?$/.test(target)) continue;
      const next = moduleId(root, target);
      if (previous.has(next)) continue;
      previous.set(next, id);
      fileOf.set(next, target);
      queue.push(next);
    }
  }
  return {
    ids: new Set(previous.keys()),
    pathTo(id) {
      const path: ModuleId[] = [];
      for (let at: ModuleId | null | undefined = id; at; at = previous.get(at) ?? null) path.unshift(at);
      return path;
    },
  };
}

/**
 * What one file exports, and where each exported binding is implemented.
 *
 * `declared` is a name this file implements: `export function`, `export const`,
 * or a bare `export { Local }` over a binding declared here.
 *
 * `reexported` is a name implemented elsewhere, whether written
 * `export { X } from "./mod"` or imported first and then exported under an alias:
 * `import { Button as Imported } from "./button"; export { Imported as Button }`
 * forwards `./button`'s component, so it is a re-export of `Button` and not a
 * second implementation. Default (`import Def from`) and namespace
 * (`import * as ns from`) aliases are tracked the same way.
 *
 * `starReexports` lists the specifiers of `export * from "./mod"`, whose names
 * this file cannot enumerate, so a caller guarding against a re-implemented
 * export must also require it to be empty.
 *
 * A bare export whose local binding is neither declared here nor imported is
 * reported as `declared`: that is the conservative direction, since claiming a
 * re-export for an unresolvable name could hide a local implementation.
 */
export type ExportSurface = { declared: string[]; reexported: string[]; starReexports: string[] };

/** Every top-level binding name this file declares itself. */
function localBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  function fromDeclarationList(list: ts.VariableDeclarationList): void {
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      fromDeclarationList(statement.declarationList);
    }
  }
  return names;
}

/** Local binding name -> the module it was imported from. */
function importedBindings(source: ts.SourceFile): Map<string, string> {
  const origins = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = specifierText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (!specifier || !clause) continue;
    if (clause.name) origins.set(clause.name.text, specifier);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      origins.set(clause.namedBindings.name.text, specifier);
      continue;
    }
    for (const element of clause.namedBindings.elements) origins.set(element.name.text, specifier);
  }
  return origins;
}

export function exportedNames(file: string): ExportSurface {
  const source = parse(file);
  const local = localBindings(source);
  const imported = importedBindings(source);
  const declared: string[] = [];
  const reexported: string[] = [];
  const starReexports: string[] = [];
  const isExported = (node: ts.Node) => ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && isExported(statement)) {
      if (statement.name) declared.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = specifierText(statement.moduleSpecifier);
    const named = statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause : null;
    if (!specifier) {
      // Bare `export { ... }`: each name is local or an imported alias.
      for (const element of named?.elements ?? []) {
        const binding = (element.propertyName ?? element.name).text;
        if (imported.has(binding)) reexported.push(element.name.text);
        else if (local.has(binding)) declared.push(element.name.text);
        else declared.push(element.name.text);
      }
      continue;
    }
    if (named) {
      for (const element of named.elements) reexported.push(element.name.text);
    } else {
      starReexports.push(specifier);
    }
  }
  return { declared: declared.sort(), reexported: reexported.sort(), starReexports: starReexports.sort() };
}

/**
 * One architecture layer's import policy.
 *
 * `allowedRoots` / `allowedModules` are the whole contract: anything the layer
 * reaches that is not inside them is a violation, whether the edge is direct or
 * arrives through an allowed library that re-exports it. The prohibited lists
 * add no restriction; they exist so a failure names the application module that
 * was reached instead of only saying "not allowed".
 */
export type LayerPolicy = {
  name: string;
  /** Module-id prefix holding the layer's own files. */
  root: string;
  allowedRoots: string[];
  allowedModules: string[];
  prohibitedModules: string[];
  prohibitedRoots: string[];
  /**
   * Sanctioned connected adapters inside the layer, as module ids. They are not
   * audited, because reaching application state is their whole job; a companion
   * assertion checks that this list is exactly the set of files that do.
   */
  exclude?: string[];
  /**
   * Declared opaque dependencies, matched as module-id prefixes: allowed to
   * import, but their own dependencies are not traversed. This exists for two
   * things — the legacy paint call a page still makes until the declarative App
   * root lands, and the core domain layer, whose internal boundaries are core's
   * own audited responsibility rather than something a page re-audits. Without
   * it, a page importing one domain action would be charged with the whole graph
   * behind it. When the App root lands, `paint` leaves this list.
   */
  opaque?: string[];
};

export type LayerReport = {
  layer: string;
  /** Audited production modules in the layer. */
  modules: number;
  /** Direct edges leaving the allowlist, as `from -> to`. */
  direct: string[];
  /** Transitive reaches leaving the allowlist, each with its full path. */
  transitive: string[];
  /** Transitive reaches of a named prohibited module, each with its full path. */
  prohibited: string[];
};

export function isAllowed(policy: LayerPolicy, id: ModuleId): boolean {
  return policy.allowedModules.includes(id)
    || policy.allowedRoots.some(root => id.startsWith(root));
}

export function prohibitedName(policy: LayerPolicy, id: ModuleId): string | null {
  if (policy.prohibitedModules.includes(id)) return id;
  return policy.prohibitedRoots.find(root => id.startsWith(root)) ?? null;
}

/** Audit one layer: its own modules plus everything they can transitively reach. */
export function auditLayer(root: string, policy: LayerPolicy): LayerReport {
  const excluded = new Set(policy.exclude ?? []);
  const entries = productionModules(root, policy.root)
    .filter(file => !excluded.has(moduleId(root, file)));
  const direct: string[] = [];
  for (const file of entries) {
    const id = moduleId(root, file);
    for (const dependency of dependencyIds(root, file)) {
      if (!isAllowed(policy, dependency)) direct.push(`${id} -> ${dependency}`);
    }
  }
  const reach = reachable(root, entries, policy.opaque ?? []);
  const transitive: string[] = [];
  const prohibited: string[] = [];
  for (const id of [...reach.ids].sort()) {
    // The prohibited lists name a violation, they do not add one: a module the
    // policy explicitly allows (a sanctioned primitive such as app/store) is not
    // also reported for matching a prohibited prefix.
    if (isAllowed(policy, id)) continue;
    transitive.push(reach.pathTo(id).join(" -> "));
    const banned = prohibitedName(policy, id);
    if (banned) prohibited.push(`[${banned}] ${reach.pathTo(id).join(" -> ")}`);
  }
  return { layer: policy.name, modules: entries.length, direct, transitive, prohibited };
}
