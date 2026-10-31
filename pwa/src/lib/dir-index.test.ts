import { beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../test-support/boot-dom";
import {
  DIR_INDEX_CACHE_KEY,
  DIR_INDEX_MAX_ROWS,
  filterDirs,
  parseDirIndex,
  readDirIndexCache,
  writeDirIndexCache,
  type DirIndex,
  type DirIndexEntry,
} from "./dir-index";

const VERSION = "9f2c4b1a8e6d0f37";

function entry(path: string, repo = false): DirIndexEntry {
  const cut = path.lastIndexOf("/");
  return { path, name: path.slice(cut + 1), parent: cut > 0 ? path.slice(0, cut) : "/", repo };
}

function reply(rows: Array<{ p: string; r: boolean }> = [{ p: "Project", r: false }]) {
  return {
    version: VERSION,
    roots: [{ path: "/Users/arron", repo: false, dirs: rows }],
    truncated: false,
  };
}

beforeEach(async () => {
  await resetTestDOM();
  localStorage.clear();
});

describe("parseDirIndex", () => {
  test("flattens roots and rows into pickable entries", () => {
    expect(parseDirIndex(reply([
      { p: "Project", r: false },
      { p: "Project/github/pairfob", r: true },
    ]))).toEqual({
      version: VERSION,
      truncated: false,
      entries: [
        { path: "/Users/arron/Project", name: "Project", parent: "/Users/arron", repo: false },
        { path: "/Users/arron/Project/github/pairfob", name: "pairfob", parent: "/Users/arron/Project/github", repo: true },
      ],
    });
  });

  test("a row that leaves out the repo mark is not a repository", () => {
    const parsed = parseDirIndex({ ...reply(), roots: [{ path: "/w", repo: false, dirs: [{ p: "a" }] }] });
    expect(parsed?.entries[0]).toEqual({ path: "/w/a", name: "a", parent: "/w", repo: false });
  });

  test("keeps a root at a filesystem root joined without a double slash", () => {
    const parsed = parseDirIndex({ version: VERSION, roots: [{ path: "/", repo: true, dirs: [{ p: "work", r: false }] }], truncated: false });
    expect(parsed?.entries[0]).toEqual({ path: "/work", name: "work", parent: "/", repo: false });
  });

  test("the unchanged answer is null, and nothing else may look like it", () => {
    expect(parseDirIndex({ unchanged: true })).toBeNull();
    expect(() => parseDirIndex({ unchanged: false })).toThrow();
    expect(() => parseDirIndex({ unchanged: true, version: VERSION })).toThrow();
  });

  test.each([
    ["a top-level unknown key", { ...reply(), extra: true }],
    ["a missing version", { roots: reply().roots, truncated: false }],
    ["an uppercase version", { ...reply(), version: VERSION.toUpperCase() }],
    ["a short version", { ...reply(), version: "0123456789abcde" }],
    ["roots that are not an array", { ...reply(), roots: {} }],
    ["a root with an unknown key", { ...reply(), roots: [{ path: "/w", repo: false, dirs: [], extra: 1 }] }],
    ["an empty root path", { ...reply(), roots: [{ path: "", repo: false, dirs: [] }] }],
    ["a root repo that is not a boolean", { ...reply(), roots: [{ path: "/w", repo: "no", dirs: [] }] }],
    ["dirs that are not an array", { ...reply(), roots: [{ path: "/w", repo: false, dirs: {} }] }],
    ["a row with an unknown key", reply([{ p: "a", r: false, extra: true } as unknown as { p: string; r: boolean }])],
    ["an absolute row path", reply([{ p: "/a", r: false }])],
    ["a row escaping its root", reply([{ p: "a/../b", r: false }])],
    ["a row with an empty segment", reply([{ p: "a//b", r: false }])],
    ["a row that is not a directory name", reply([{ p: "", r: false }])],
    ["a row repo that is not a boolean", reply([{ p: "a", r: "yes" } as unknown as { p: string; r: boolean }])],
    ["truncated that is not a boolean", { ...reply(), truncated: "no" }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseDirIndex(value)).toThrow();
  });

  test("refuses one path named twice and more rows than the daemon may send", () => {
    expect(() => parseDirIndex(reply([{ p: "a", r: false }, { p: "a", r: true }]))).toThrow();
    const rows = Array.from({ length: DIR_INDEX_MAX_ROWS + 1 }, (_, index) => ({ p: `d${index}`, r: false }));
    expect(() => parseDirIndex(reply(rows))).toThrow();
  });
});

describe("filterDirs", () => {
  const entries: DirIndexEntry[] = [
    entry("/w/pairfob", true),
    entry("/w/pairfob-review-archive"),
    entry("/w/src/pair"),
    entry("/w/pairbox/inside"),
    entry("/w/other"),
  ];

  test("ranks an equal name, a prefix, a contained name, then a path-only hit", () => {
    expect(filterDirs(entries, "pair").map((item) => item.path)).toEqual([
      "/w/src/pair",
      "/w/pairfob",
      "/w/pairfob-review-archive",
      "/w/pairbox/inside",
    ]);
  });

  test("every whitespace-separated token must appear in the path", () => {
    const paths = filterDirs(entries, "  GH   pair ").map((item) => item.path);
    expect(paths).toEqual([]);
    const withGithub = [...entries, entry("/w/Project/github/pairfob", true), entry("/w/github/pairfob-review-archive")];
    expect(filterDirs(withGithub, "git pair").map((item) => item.path)).toEqual([
      "/w/Project/github/pairfob",
      "/w/github/pairfob-review-archive",
    ]);
  });

  test("ties go to the shorter name, then the shallower path, then the path's order", () => {
    const byName = [entry("/w/application"), entry("/w/app")];
    expect(filterDirs(byName, "app").map((item) => item.name)).toEqual(["app", "application"]);
    const byDepth = [entry("/w/deep/app"), entry("/w/app")];
    expect(filterDirs(byDepth, "app").map((item) => item.path)).toEqual(["/w/app", "/w/deep/app"]);
    const byOrder = [entry("/w/zeta/app"), entry("/w/alpha/app")];
    expect(filterDirs(byOrder, "app").map((item) => item.path)).toEqual(["/w/alpha/app", "/w/zeta/app"]);
  });

  test("an empty query keeps the first entries in path order and honours the limit", () => {
    const many = Array.from({ length: 70 }, (_, index) => entry(`/w/d${String(index).padStart(2, "0")}`));
    const first = filterDirs(many, "");
    expect(first.length).toBe(60);
    expect(first[0]).toBe(many[0]);
    expect(filterDirs(many, "  ").length).toBe(60);
    expect(filterDirs(many, "", 5).map((item) => item.name)).toEqual(["d00", "d01", "d02", "d03", "d04"]);
    expect(filterDirs(many, "", 0)).toEqual([]);
  });

  test("a query caps its answer at the same limit", () => {
    const many = Array.from({ length: 70 }, (_, index) => entry(`/w/app-${String(index).padStart(2, "0")}`));
    expect(filterDirs(many, "app").length).toBe(60);
  });
});

describe("the phone's copy", () => {
  const index: DirIndex = {
    version: VERSION,
    truncated: false,
    entries: [entry("/Users/arron/Project", true), entry("/Users/arron/other")],
  };

  test("round-trips under the machine and refuses another machine's copy", () => {
    writeDirIndexCache("d_daemon1", index);
    expect(readDirIndexCache("d_daemon1")).toEqual(index);
    expect(readDirIndexCache("d_daemon2")).toBeNull();
    expect(localStorage.getItem(DIR_INDEX_CACHE_KEY)).not.toBeNull();
  });

  test("a malformed cached copy reads as absent instead of half an index", () => {
    localStorage.setItem(DIR_INDEX_CACHE_KEY, JSON.stringify({ host: "d_daemon1", index: { ...index, version: "nope" } }));
    expect(readDirIndexCache("d_daemon1")).toBeNull();
    localStorage.setItem(DIR_INDEX_CACHE_KEY, JSON.stringify({ host: "d_daemon1", index: { ...index, extra: true } }));
    expect(readDirIndexCache("d_daemon1")).toBeNull();
    localStorage.setItem(DIR_INDEX_CACHE_KEY, "not json");
    expect(readDirIndexCache("d_daemon1")).toBeNull();
  });

  test("a copy over the size cap is not written", () => {
    const huge = "x".repeat(200);
    const oversized: DirIndex = {
      version: VERSION,
      truncated: false,
      entries: Array.from({ length: 10_000 }, (_, index) => entry(`/${huge}/${index}`, false)),
    };
    writeDirIndexCache("d_daemon1", oversized);
    expect(localStorage.getItem(DIR_INDEX_CACHE_KEY)).toBeNull();
  });
});
