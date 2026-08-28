import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

function isExecutable(type: string | null): boolean {
  if (!type) return true;
  const t = type.trim().toLowerCase();
  return t === "module" || t === "text/javascript" || t === "application/javascript" || t === "text/ecmascript";
}

/** Pull executable inline <script> bodies into hashed files so CSP can forbid unsafe-inline. */
export function rewriteHtml(
  html: string,
  writeAsset: (filename: string, source: string) => void,
  publicPrefix: string,
): string {
  return html.replace(SCRIPT_RE, (full, rawAttrs: string, body: string) => {
    const attrs = rawAttrs ?? "";
    if (attr(attrs, "src")) return full;
    if (!isExecutable(attr(attrs, "type"))) return full;
    const source = body.trim();
    if (!source) return full;
    const digest = createHash("sha256").update(source).digest("base64url").slice(0, 10);
    const filename = `inline-${digest}.js`;
    writeAsset(filename, source.endsWith("\n") ? source : source + "\n");
    const module = attr(attrs, "type") === "module" ? ' type="module"' : "";
    return `<script${module} src="${publicPrefix}${filename}"></script>`;
  });
}

function listHtml(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) listHtml(path, out);
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

function stillHasInline(html: string): boolean {
  SCRIPT_RE.lastIndex = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? "";
    if (attr(attrs, "src")) continue;
    if (!isExecutable(attr(attrs, "type"))) continue;
    if (!(m[2] ?? "").trim()) continue;
    return true;
  }
  return false;
}

export function rewriteTree(distDir: string, publicPrefix = "/doc/assets/"): number {
  const assetDir = join(distDir, "assets");
  mkdirSync(assetDir, { recursive: true });
  let rewritten = 0;
  for (const file of listHtml(distDir)) {
    const before = readFileSync(file, "utf8");
    const after = rewriteHtml(before, (filename, source) => {
      writeFileSync(join(assetDir, filename), source);
    }, publicPrefix);
    if (after !== before) {
      writeFileSync(file, after);
      rewritten++;
    }
    if (stillHasInline(after)) {
      throw new Error(`inline script remains in ${file}`);
    }
  }
  return rewritten;
}

export function extractInlineScripts(): Plugin {
  return {
    name: "extract-inline-scripts",
    apply: "build",
    closeBundle() {
      rewriteTree(join(process.cwd(), ".vitepress/dist"));
    },
  };
}
