import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packSelfhostAssets } from "./selfhost-pack.ts";

const OLD_ID = "0123456789abcdef";
const NEW_ID = "fedcba9876543210";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pairfob-selfhost-pack-"));
}

async function makePwaDist(
  root: string,
  generation: string,
  asset: string,
): Promise<string> {
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await mkdir(join(dist, ".vite"), { recursive: true });
  await writeFile(
    join(dist, "index.html"),
    `<!doctype html><html><head><meta name="pairfob-assets" content="/assets/pwa-assets-${generation}.json"></head><body><div id="app"></div></body></html>`,
  );
  await writeFile(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});\n");
  await writeFile(
    join(dist, "assets", `pwa-assets-${generation}.json`),
    JSON.stringify({ assets: [`/assets/${asset}`] }),
  );
  await writeFile(join(dist, "assets", asset), `console.log(${JSON.stringify(asset)});\n`);
  await writeFile(join(dist, ".vite", "manifest.json"), "{}");
  await mkdir(join(dist, "preview"), { recursive: true });
  await writeFile(join(dist, "preview", "runner.html"), "<!doctype html><p>preview</p>");
  return dist;
}

async function makeInstaller(root: string): Promise<string> {
  const path = join(root, "install.sh");
  await writeFile(path, "#!/bin/sh\necho install\n");
  return path;
}

describe("packSelfhostAssets", () => {
  test("lays out the relay landing page, PWA shell and installer", async () => {
    const root = await tempDir();
    try {
      const dist = await makePwaDist(root, OLD_ID, "app-aaaaaaaa.js");
      const installer = await makeInstaller(root);
      const dest = join(root, "public");

      await packSelfhostAssets({ pwaDist: dist, dest, installScript: installer });

      const index = await readFile(join(dest, "index.html"), "utf8");
      expect(index).toContain("Pairfob relay");
      expect(index).toContain('href="/pair"');

      const shell = await readFile(join(dist, "index.html"), "utf8");
      expect(await readFile(join(dest, "pair", "index.html"), "utf8")).toBe(shell);
      expect(await readFile(join(dest, "pair.html"), "utf8")).toBe(shell);
      expect(await readFile(join(dest, "pair-shell.asset"), "utf8")).toBe(shell);
      expect(await readFile(join(dest, "sw.js"), "utf8")).toContain("addEventListener");
      expect(await readFile(join(dest, "install.sh"), "utf8")).toContain("echo install");
      expect(await readFile(join(dest, "assets", "app-aaaaaaaa.js"), "utf8")).toContain("app-aaaaaaaa.js");
      expect(await readFile(join(dest, "assets", `pwa-assets-${OLD_ID}.json`), "utf8")).toContain(
        "app-aaaaaaaa.js",
      );
      expect(await readFile(join(dest, "preview-runner.asset"), "utf8")).toContain("preview");
      expect(existsSync(join(dest, ".vite"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps the previous asset generation on a redeploy", async () => {
    const root = await tempDir();
    try {
      const installer = await makeInstaller(root);
      const dest = join(root, "public");
      const first = await makePwaDist(join(root, "v1"), OLD_ID, "app-aaaaaaaa.js");
      await packSelfhostAssets({ pwaDist: first, dest, installScript: installer });

      const second = await makePwaDist(join(root, "v2"), NEW_ID, "app-bbbbbbbb.js");
      await packSelfhostAssets({
        pwaDist: second,
        dest,
        installScript: installer,
        previousPublic: dest,
      });

      const assets = (await readdir(join(dest, "assets"))).sort();
      expect(assets).toContain("app-aaaaaaaa.js");
      expect(assets).toContain("app-bbbbbbbb.js");
      expect(assets).toContain(`pwa-assets-${NEW_ID}.json`);
      expect(assets).toContain(`pwa-assets-${OLD_ID}.json`);
      expect(assets).toContain("releases.json");

      expect(await readFile(join(dest, "index.html"), "utf8")).toContain("Pairfob relay");
      expect(await readFile(join(dest, "pair", "index.html"), "utf8")).toContain(NEW_ID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses to pack into the PWA build or a parent of it", async () => {
    const root = await tempDir();
    try {
      const dist = await makePwaDist(root, OLD_ID, "app-aaaaaaaa.js");
      const installer = await makeInstaller(root);
      await expect(packSelfhostAssets({ pwaDist: dist, dest: dist, installScript: installer })).rejects.toThrow();
      await expect(
        packSelfhostAssets({ pwaDist: dist, dest: join(dist, "public"), installScript: installer }),
      ).rejects.toThrow();
      // A parent of the build would be replaced along with the build.
      await expect(
        packSelfhostAssets({ pwaDist: dist, dest: root, installScript: installer }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("requires a real PWA build and installer", async () => {
    const root = await tempDir();
    try {
      const dist = await makePwaDist(root, OLD_ID, "app-aaaaaaaa.js");
      const installer = await makeInstaller(root);
      await expect(
        packSelfhostAssets({ pwaDist: join(root, "missing"), dest: join(root, "public"), installScript: installer }),
      ).rejects.toThrow();
      await expect(
        packSelfhostAssets({ pwaDist: dist, dest: join(root, "public"), installScript: join(root, "missing.sh") }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
