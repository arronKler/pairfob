import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair" });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Node"] as const) {
  globals[key] = (happy as unknown as Record<string, unknown>)[key];
}

const { chromeActionCluster } = await import("./chrome-actions.ts");

describe("workspace chrome entry", () => {
  test("is available by default before more", () => {
    const cluster = chromeActionCluster(() => {}, () => {});
    expect(cluster.querySelector(".icon-workspace")?.getAttribute("aria-label")).toBe("查看文件与更改");
    expect(cluster.querySelectorAll("button")).toHaveLength(2);
    expect(cluster.firstElementChild?.classList.contains("icon-workspace")).toBeTrue();
  });
});
