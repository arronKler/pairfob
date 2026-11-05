import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { compileScss } from "../../../../test-support/compiled-style";
import { FULL_TERM_FONT_FAMILY } from "../../../features/session/full-terminal/full-terminal-fit";
import { ICON_FAMILY, ICON_RANGES_BMP, ICON_RANGES_MDI, iconFace } from "./term-glyphs";

const fonts = new URL("./", import.meta.url);
const rules = await Bun.file(new URL("icon-font.css", fonts)).text();
const tokens = compileScss(new URL("../../../style.scss", import.meta.url)).css;

/** WOFF2 known table tags, by the index its directory stores. */
const CMAP = 0;
const GLYF = 10;
const LOCA = 11;

/** Every code point a WOFF2 file maps to a glyph. */
async function codePoints(name: string): Promise<number[]> {
  const file = new Uint8Array(await Bun.file(new URL(name, fonts)).arrayBuffer());
  const view = new DataView(file.buffer);
  expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("wOF2");
  const tables = view.getUint16(12);
  const compressed = view.getUint32(20);
  let at = 48;
  const base128 = (): number => {
    let value = 0;
    for (;;) {
      const byte = file[at++];
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
  };
  let offset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let index = 0; index < tables; index++) {
    const flags = file[at++];
    const tag = flags & 0x3f;
    if (tag === 0x3f) at += 4;
    const version = flags >> 6;
    const original = base128();
    // glyf and loca are transformed unless marked otherwise; every other table the other way round.
    const transformed = tag === GLYF || tag === LOCA ? version === 0 : version !== 0;
    const length = transformed ? base128() : original;
    if (tag === CMAP) cmap = { offset, length };
    offset += length;
  }
  const data = brotliDecompressSync(file.subarray(at, at + compressed));
  if (!cmap) throw new Error(`${name} has no cmap`);
  const table = new DataView(data.buffer, data.byteOffset + cmap.offset, cmap.length);
  const found = new Set<number>();
  for (let record = 0; record < table.getUint16(2); record++) {
    const sub = table.getUint32(4 + record * 8 + 4);
    const format = table.getUint16(sub);
    if (format === 12) {
      for (let group = 0; group < table.getUint32(sub + 12); group++) {
        const first = table.getUint32(sub + 16 + group * 12);
        const last = table.getUint32(sub + 20 + group * 12);
        for (let codePoint = first; codePoint <= last; codePoint++) found.add(codePoint);
      }
    } else if (format === 4) {
      const segments = table.getUint16(sub + 6) / 2;
      for (let segment = 0; segment < segments; segment++) {
        const last = table.getUint16(sub + 14 + segment * 2);
        const first = table.getUint16(sub + 16 + segments * 2 + segment * 2);
        if (last === 0xffff) continue;
        for (let codePoint = first; codePoint <= last; codePoint++) found.add(codePoint);
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** The `unicode-range` of the rule that names a file, as [first, last] pairs. */
function declared(name: string): [number, number][] {
  const rule = rules.split("@font-face").find((block) => block.includes(name));
  const list = rule?.match(/unicode-range:\s*([^;]+);/)?.[1];
  if (!list) throw new Error(`no unicode-range for ${name}`);
  return list.split(",").map((part) => {
    const [first, last = first] = part.trim().replace(/^U\+/i, "").split("-");
    return [Number.parseInt(first, 16), Number.parseInt(last, 16)];
  });
}

const FILES = [
  { name: "symbols-nerd-font-bmp.woff2", face: "bmp", ranges: ICON_RANGES_BMP },
  { name: "symbols-nerd-font-mdi.woff2", face: "mdi", ranges: ICON_RANGES_MDI },
] as const;

describe("the icon faces", () => {
  for (const { name, face, ranges } of FILES) {
    test(`${name}: the stylesheet and the code name the same ranges`, () => {
      expect(declared(name)).toEqual(ranges.map(([first, last]) => [first, last]));
    });

    test(`${name}: every glyph in the file is reachable, and every range has glyphs`, async () => {
      const held = await codePoints(name);
      expect(held.length).toBeGreaterThan(3000);
      // A glyph outside the ranges would never be asked for.
      expect(held.filter((codePoint) => iconFace(codePoint) !== face)).toEqual([]);
      // A range the file does not serve would fetch it for nothing.
      for (const [first, last] of ranges) {
        expect(held.some((codePoint) => codePoint >= first && codePoint <= last)).toBe(true);
        expect(held).toContain(first);
        expect(held).toContain(last);
      }
    });
  }

  test("each file has a family of its own, named the same in the rules and in the code", () => {
    for (const { name, face } of FILES) {
      const rule = rules.split("@font-face").find((block) => block.includes(name)) ?? "";
      expect(`"${rule.match(/font-family:\s*"([^"]+)"/)?.[1]}"`).toBe(ICON_FAMILY[face]);
    }
    expect(ICON_FAMILY.bmp).not.toBe(ICON_FAMILY.mdi);
  });

  test("ordinary text is set in no list that names an icon family", () => {
    // Leading a list, the family is what WebKit reads metrics from; ending one, a late face goes unused.
    for (const token of ["font", "mono"]) {
      const list = tokens.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1] ?? "";
      expect(list.length).toBeGreaterThan(20);
      expect(list).not.toContain("Pairfob");
    }
    // The complete terminal draws its screen again when a face arrives, so its list may end with them.
    const terminal = FULL_TERM_FONT_FAMILY.split(",").map((family) => family.trim());
    expect(terminal.slice(-3)).toEqual([ICON_FAMILY.bmp, ICON_FAMILY.mdi, "monospace"]);
    expect(terminal[0]).toBe("ui-monospace");
  });

  test("in a grid the glyph names its own face first, and the cell that sizes it does not", () => {
    const rule = (selector: string) => tokens.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".cell-glyph")).toMatch(/font-family:\s*"Pairfob Symbols", var\(--mono\)/);
    expect(rule(".cell-glyph-mdi")).toMatch(/font-family:\s*"Pairfob Symbols MDI", var\(--mono\)/);
    expect(rule(".cell-icon")).not.toMatch(/font-family/);
  });

  test("both entries load the rules", async () => {
    expect(await Bun.file(new URL("../../../main.ts", import.meta.url)).text()).toContain('import "./shared/ui/fonts/icon-font.css"');
    expect(await Bun.file(new URL("../../../../qa/bootstrap.ts", import.meta.url)).text()).toContain('import("/src/shared/ui/fonts/icon-font.css")');
  });
});
