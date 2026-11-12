/**
 * Pack the browser app and installer into the static assets of a self-hosted
 * Cloudflare relay.
 *
 * The web PWA deliberately keeps its own page origin as the relay origin, so a
 * self-hosted relay must serve the PWA instead of loading it from pairfob.com.
 * The production packer also ships the marketing site and VitePress docs; this
 * packer ships only what the relay needs.
 */

import { access, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { renderRelayIndex } from "./selfhost-config.ts";
import { retainPwaAssets } from "./retain-pwa-assets.ts";

export type PackOptions = {
  pwaDist: string;
  dest: string;
  installScript: string;
  /** The previous packed public directory, when this is an update. */
  previousPublic?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireFile(path: string, label: string): Promise<void> {
  if (!(await exists(path))) throw new Error(`missing ${label}: ${path}`);
}

function assertSafeDestination(dest: string, pwaDist: string): void {
  const target = resolve(dest);
  const source = resolve(pwaDist);
  // The pack replaces `dest` wholesale, so it must not be the build itself, a
  // directory inside it, or a parent that contains it.
  if (target === "/" || target === source || target.startsWith(source + sep) || source.startsWith(target + sep)) {
    throw new Error(`refusing to pack into ${target}`);
  }
}

/**
 * Build the relay's static asset tree.
 *
 * Layout mirrors the production origin: the PWA shell is served at `/pair`
 * (and `/pair.html`), while `/` is a small landing page. The Worker fetches
 * `pair-shell.asset` for `/pair` so Cloudflare Assets cannot canonicalize the
 * route back to itself.
 */
export async function packSelfhostAssets(options: PackOptions): Promise<void> {
  const pwaDist = resolve(options.pwaDist);
  const dest = resolve(options.dest);
  assertSafeDestination(dest, pwaDist);
  await requireFile(join(pwaDist, "index.html"), "PWA build");
  await requireFile(join(pwaDist, "sw.js"), "PWA service worker");
  await requireFile(options.installScript, "installer");

  const parent = join(dest, "..");
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".pairfob-selfhost-"));
  try {
    await mkdir(join(staging, "pair"), { recursive: true });
    await cp(pwaDist, staging, { recursive: true });
    // The Vite manifest is build evidence, not a public asset.
    await rm(join(staging, ".vite"), { recursive: true, force: true });

    if (options.previousPublic && (await exists(join(options.previousPublic, "assets")))) {
      const retained = await mkdtemp(join(parent, ".pairfob-retain-"));
      try {
        await retainPwaAssets(options.previousPublic, pwaDist, retained);
        await cp(join(retained, "assets"), join(staging, "assets"), { recursive: true });
      } finally {
        await rm(retained, { recursive: true, force: true });
      }
    }

    await writeFile(join(staging, "index.html"), renderRelayIndex());
    await cp(join(pwaDist, "index.html"), join(staging, "pair", "index.html"));
    await cp(join(pwaDist, "index.html"), join(staging, "pair.html"));
    await cp(join(pwaDist, "index.html"), join(staging, "pair-shell.asset"));
    // The Worker serves the preview runner from an opaque asset name so Assets
    // HTML canonicalization cannot redirect it.
    if (await exists(join(pwaDist, "preview", "runner.html"))) {
      await cp(join(pwaDist, "preview", "runner.html"), join(staging, "preview-runner.asset"));
    }
    await cp(options.installScript, join(staging, "install.sh"));

    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [pwaDist, dest, installScript, previousPublic] = process.argv.slice(2);
  if (!pwaDist || !dest || !installScript) {
    throw new Error("Usage: selfhost-pack.ts <pwa-dist> <dest> <install.sh> [previous-public]");
  }
  await packSelfhostAssets({ pwaDist, dest, installScript, previousPublic });
  console.log(`selfhost: packed ${dest}`);
}
