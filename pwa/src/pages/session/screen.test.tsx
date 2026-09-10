import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionScreen, sessionViewKind } from "./screen";

describe("session page composition", () => {
  test("selects guided, agent, or full views from kind", () => {
    expect(SessionScreen({ kind: "guided", guided: "g", chat: "c", terminal: "t" })).toBe("g");
    expect(SessionScreen({ kind: sessionViewKind({ agentChat: true }), guided: "g", chat: "c", terminal: "t" })).toBe("c");
    expect(SessionScreen({ kind: sessionViewKind({ fullTerminal: true }), guided: "g", chat: "c", terminal: "t" })).toBe("t");
  });

  test("page composition does not import state, paint, or document", () => {
    const source = readFileSync(fileURLToPath(new URL("./screen.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from ["'].*\/state["']/);
    expect(source).not.toMatch(/from ["'].*\/paint["']/);
    expect(source).not.toContain("document.");
    expect(source).not.toContain("registerSessionView");
    expect(source).not.toContain("bindSessionOwnerFromLive");
  });
});
