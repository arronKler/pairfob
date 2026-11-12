import { describe, expect, test } from "bun:test";
import { installCommandFor } from "./install-command";

describe("installCommandFor", () => {
  test("keeps the canonical command on the official instance", () => {
    expect(installCommandFor("https://pairfob.com")).toBe("curl -fsSL https://pairfob.com/install.sh | sh");
  });

  test("points a self-hosted relay at itself", () => {
    expect(installCommandFor("https://relay.example.com")).toBe(
      "curl -fsSL https://relay.example.com/install.sh | sh -s -- --origin https://relay.example.com",
    );
  });

  test("tolerates a trailing slash", () => {
    expect(installCommandFor("https://relay.example.com/")).toBe(
      "curl -fsSL https://relay.example.com/install.sh | sh -s -- --origin https://relay.example.com",
    );
  });
});
