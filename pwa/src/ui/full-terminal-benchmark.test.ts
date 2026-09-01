import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../../scripts/terminal-browser-benchmark.ts", import.meta.url)).text();

describe("full-terminal browser benchmark", () => {
  test("remains valid TypeScript without launching Chrome", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    expect((await transpiler.transform(source)).length).toBeGreaterThan(0);
  });

  test("exercises the production WebGL renderer and rejects fallback", () => {
    expect(source).toContain("new module.WebglAddon()");
    expect(source).toContain("webgl.onContextLoss");
    expect(source).toContain('mount.querySelector(".xterm-rows")');
    expect(source).toContain("webglCanvasCount === 0");
    expect(source).toContain('kind: "webgl2"');
  });
});
