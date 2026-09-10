import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adoptSessionOwner, sessionOwner } from "./identity";

describe("session owner identity", () => {
  test("binds a stable key for one session object and a new key after a controller adopt", () => {
    const sessionA = { id: "a" };
    const sessionB = { id: "b" };
    const first = adoptSessionOwner({ session: sessionA, paneId: "p1", viewIncarnation: 1 });
    expect(sessionOwner().key).toBe(first.key);
    const same = adoptSessionOwner({ session: sessionA, paneId: "p1", viewIncarnation: 1 });
    expect(same.key).toBe(first.key);
    const pane = adoptSessionOwner({ session: sessionA, paneId: "p2", viewIncarnation: 1 });
    expect(pane.key).not.toBe(first.key);
    const next = adoptSessionOwner({ session: sessionB, paneId: "p1", viewIncarnation: 1 });
    expect(next.key).not.toBe(first.key);
    expect(next.session).toBe(sessionB);
    const bumped = adoptSessionOwner({ session: sessionA, paneId: "p1", viewIncarnation: 2 });
    expect(bumped.key).not.toBe(first.key);
  });

  test("ports and pure models stay free of state, paint, and document", () => {
    for (const name of [
      "ports.ts",
      "model.ts",
      "identity.ts",
      "guided/model.ts",
      "chat/model.ts",
      "chat/details.ts",
      "full-terminal/model.ts",
      "keypad/keys.ts",
      "keypad/modifiers.ts",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
      expect(source).not.toMatch(/from ["']\.\.\/.*\/state["']/);
      expect(source).not.toMatch(/from ["']\.\.\/.*\/paint["']/);
      expect(source).not.toContain("document.");
    }
  });
});
