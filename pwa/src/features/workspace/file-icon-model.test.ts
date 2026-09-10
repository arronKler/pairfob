import { describe, expect, test } from "bun:test";
import { fileIconFor, FILE_ICON_GLYPH, FILE_ICON_GLYPHS } from "./file-icon-model";
import type { FileIconId } from "./file-icon-glyphs";

describe("fileIconFor", () => {
  test("directories and symlinks ignore the name", () => {
    expect(fileIconFor("directory", "app.ts")).toBe("folder");
    expect(fileIconFor("symlink", "app.ts")).toBe("symlink");
    expect(fileIconFor("other", "blob")).toBe("binary");
  });

  test("exact names beat extensions", () => {
    expect(fileIconFor("file", "package.json")).toBe("npm");
    expect(fileIconFor("file", "src/package.json")).toBe("npm");
    expect(fileIconFor("file", "go.mod")).toBe("go");
    expect(fileIconFor("file", "Cargo.toml")).toBe("rs");
    expect(fileIconFor("file", ".gitignore")).toBe("git");
    expect(fileIconFor("file", "Dockerfile")).toBe("docker");
    expect(fileIconFor("file", "Dockerfile.prod")).toBe("docker");
    expect(fileIconFor("file", "LICENSE")).toBe("license");
    expect(fileIconFor("file", "license.md")).toBe("license");
    expect(fileIconFor("file", "README.md")).toBe("md");
    expect(fileIconFor("file", "tsconfig.json")).toBe("ts");
    expect(fileIconFor("file", "tsconfig.app.json")).toBe("ts");
    expect(fileIconFor("file", "wrangler.toml")).toBe("config");
    expect(fileIconFor("file", ".env.local")).toBe("env");
    expect(fileIconFor("file", "vite.config.ts")).toBe("vite");
    expect(fileIconFor("file", "Makefile")).toBe("make");
    expect(fileIconFor("file", "compose.yaml")).toBe("docker");
  });

  test("maps common source, config, and media suffixes", () => {
    const cases: Array<[string, FileIconId]> = [
      ["app.ts", "ts"],
      ["app.d.ts", "ts"],
      ["App.tsx", "react"],
      ["index.js", "js"],
      ["mod.mjs", "js"],
      ["page.jsx", "react"],
      ["data.json", "json"],
      ["index.html", "html"],
      ["style.css", "css"],
      ["style.scss", "sass"],
      ["mixins.less", "less"],
      ["notes.md", "md"],
      ["main.go", "go"],
      ["lib.rs", "rs"],
      ["script.py", "py"],
      ["Main.java", "java"],
      ["util.c", "c"],
      ["util.cpp", "cpp"],
      ["Program.cs", "csharp"],
      ["setup.sh", "sh"],
      ["query.sql", "sql"],
      ["index.php", "php"],
      ["App.swift", "swift"],
      ["Main.kt", "kt"],
      ["main.dart", "dart"],
      ["init.lua", "lua"],
      ["App.vue", "vue"],
      ["Widget.svelte", "svelte"],
      ["page.astro", "astro"],
      ["app.yaml", "yaml"],
      ["config.toml", "toml"],
      ["data.xml", "xml"],
      ["mark.svg", "svg"],
      ["photo.png", "image"],
      ["Inter.woff2", "font"],
      ["spec.pdf", "pdf"],
      ["archive.tar.gz", "zip"],
      ["loop.mp3", "audio"],
      ["clip.mp4", "video"],
      ["table.csv", "csv"],
      ["schema.graphql", "graphql"],
      ["rpc.proto", "proto"],
      ["schema.prisma", "prisma"],
      ["main.tf", "terraform"],
      ["notes.txt", "text"],
      ["app.wasm", "wasm"],
      ["lib.ex", "elixir"],
      ["Main.hs", "haskell"],
      ["App.scala", "scala"],
      ["plot.r", "r"],
      ["shell.nix", "nix"],
      ["main.zig", "zig"],
      ["unknown", "file"],
      ["weird.notatype", "file"],
    ];
    for (const [name, id] of cases) expect(fileIconFor("file", name)).toBe(id);
  });

  test("every icon id has a glyph with at least one path", () => {
    for (const [id, glyph] of Object.entries(FILE_ICON_GLYPH)) {
      const parts = FILE_ICON_GLYPHS[glyph];
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) expect(part.d.length).toBeGreaterThan(8);
      expect(id).toBeTruthy();
    }
  });
});

describe("legal special names do not resolve to prototype values", () => {
  test("prototype-key filenames render the ordinary file, not Object", () => {
    // A legal file literally named "constructor", "toString" or "prototype"
    // must not hit Object.prototype and crash the glyph lookup.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(fileIconFor("file", name)).toBe("file");
    }
    expect(fileIconFor("file", "__proto__")).toBe("file");
    expect(fileIconFor("file", "constructor.js")).toBe("js");
    expect(fileIconFor("file", "__proto__.toml")).toBe("toml");
  });

  test("a real exact mapping keeps winning over the special fallback", () => {
    // package.json is an exact name, not "constructor"; the mapping still holds.
    expect(fileIconFor("file", "package.json")).toBe("npm");
    expect(fileIconFor("file", ".gitignore")).toBe("git");
  });
});

test("FileIcon of a prototype-key path returns a glyph, not undefined", () => {
  // The JSX path resolves through FILE_ICON_GLYPHS; a prototype-key input must
  // yield the "file" glyph (at least one path), never a crash on .map.
  const id = fileIconFor("file", "constructor");
  const glyph = FILE_ICON_GLYPHS[FILE_ICON_GLYPH[id]];
  expect(Array.isArray(glyph)).toBeTrue();
  expect(glyph.length).toBeGreaterThan(0);
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileIcon } from "./file-icon";

describe("actual FileIcon SSR with reserved basenames", () => {
  const render = (path: string) => renderToStaticMarkup(
    createElement(FileIcon, { kind: "file", path }),
  );
  test("a reserved basename renders the ordinary file glyph without crashing", () => {
    for (const path of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const html = render(path);
      expect(html).toContain('data-file-icon="file"');
      expect(html).toContain("<path");
    }
  });
  test("a dotted reserved path keeps its real extension glyph", () => {
    for (const [path, id] of [["constructor.js", "js"], ["__proto__.toml", "toml"], ["valueOf.ts", "ts"]] as const) {
      expect(render(path)).toContain(`data-file-icon="${id}"`);
    }
  });
  test("ordinary files still render their glyph through the component", () => {
    expect(render("app.ts")).toContain('data-file-icon="ts"');
    expect(render("package.json")).toContain('data-file-icon="npm"');
  });
});
