import type { WorkspaceEntry } from "../../lib/workspace";
import { FILE_ICON_GLYPH, FILE_ICON_GLYPHS, type FileIconId } from "./file-icon-glyphs";
import { FILE_ICON_EXTENSIONS, FILE_ICON_NAMES } from "./file-icon-map";

export type FileKind = WorkspaceEntry["kind"];
export type { FileIconId, GlyphPart } from "./file-icon-glyphs";
export { FILE_ICON_GLYPH, FILE_ICON_GLYPHS };

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function fromName(lower: string): FileIconId | undefined {
  const exact = FILE_ICON_NAMES[lower];
  if (exact) return exact;
  if (lower === ".env" || lower.startsWith(".env.")) return "env";
  if (lower.startsWith("dockerfile")) return "docker";
  if (lower.startsWith("docker-compose")) return "docker";
  if (/^compose\.(ya?ml|jsonc?)$/.test(lower)) return "docker";
  if (/^tsconfig(\..+)?\.jsonc?$/.test(lower)) return "ts";
  if (/^jsconfig(\..+)?\.jsonc?$/.test(lower)) return "js";
  if (/^(license|copying|unlicense)(\.|$)/.test(lower)) return "license";
  if (lower === "makefile" || lower === "gnumakefile") return "make";
  return undefined;
}

function fromExtension(lower: string): FileIconId | undefined {
  let rest = lower;
  while (rest.includes(".")) {
    const id = FILE_ICON_EXTENSIONS[rest];
    if (id) return id;
    rest = rest.slice(rest.indexOf(".") + 1);
  }
  return FILE_ICON_EXTENSIONS[rest];
}

/** Seti-style lookup: directory/symlink first, then exact name, then the longest dotted suffix. */
export function fileIconFor(kind: FileKind | undefined, nameOrPath: string): FileIconId {
  if (kind === "directory") return "folder";
  if (kind === "symlink") return "symlink";
  const lower = basename(nameOrPath).toLowerCase();
  const named = fromName(lower);
  if (named) return named;
  const dotted = lower.includes(".") ? fromExtension(lower.slice(lower.indexOf(".") + 1)) : undefined;
  if (dotted) return dotted;
  return kind === "other" ? "binary" : "file";
}

export function fileIconGlyph(id: FileIconId) {
  return FILE_ICON_GLYPHS[FILE_ICON_GLYPH[id]];
}
