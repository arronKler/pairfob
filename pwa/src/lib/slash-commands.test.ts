import { describe, expect, test } from "bun:test";
import { SLASH_COMMANDS } from "./slash-commands";

describe("slash command catalog", () => {
  test("fits a 4-column phone grid and types into the PTY as slash tokens", () => {
    expect(SLASH_COMMANDS).toHaveLength(8);
    expect(SLASH_COMMANDS.map((command) => command.label)).toEqual([
      "/clear",
      "/new",
      "/compact",
      "/model",
      "/goal",
      "/loop",
      "/usage",
      "/help",
    ]);
    for (const command of SLASH_COMMANDS) {
      expect(command.token.startsWith("/")).toBe(true);
      expect(command.label.startsWith("/")).toBe(true);
      expect(command.label.endsWith(" ")).toBe(false);
    }
  });

  test("only argument-taking tokens keep a trailing space", () => {
    const spaced = SLASH_COMMANDS.filter((command) => command.token.endsWith(" "));
    expect(spaced.map((command) => command.label)).toEqual(["/goal", "/loop"]);
  });

});
