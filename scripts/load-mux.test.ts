import { describe, expect, test } from "bun:test";
import { banner, parseArgs } from "./load-mux.ts";

describe("load-mux configuration", () => {
  test("target-only live command fails instead of silently doing nothing", () => {
    expect(() => parseArgs(["--target", "wss://pairfob.com/v2/ws", "--credentials", "/tmp/creds", "--n", "1000"]))
      .toThrow("--origin is required");
  });

  test("n>1 without credentials cannot pretend to distribute a multi-room load", () => {
    expect(() => parseArgs([
      "--origin", "https://pairfob.com", "--n", "1000",
    ])).toThrow("n>1 requires --credentials");
  });

  test("join-grant is rejected", () => {
    expect(() => parseArgs([
      "--origin", "https://pairfob.com", "--join-grant", "jg_" + "ab".repeat(16), "--n", "1",
    ])).toThrow("--join-grant is not used");
    expect(() => parseArgs([
      "--origin", "https://pairfob.com", "--join-grant=jg_" + "ab".repeat(16), "--n", "1",
    ])).toThrow("--join-grant is not used");
  });

  test("a distributed operational run has a concrete target and no secret path in its banner", () => {
    const config = parseArgs([
      "--origin", "https://pairfob.com", "--credentials", "/secure/creds.json", "--n", "10000",
    ]);
    expect(config.target).toBe("wss://pairfob.com/v2/ws");
    expect(banner(config)).toContain("credentials=configured");
    expect(banner(config)).not.toContain("/secure/creds.json");
    expect(banner(config)).toContain("not a capacity target or release gate");
  });
});
