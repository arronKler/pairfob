import { describe, expect, test } from "bun:test";

import { parseNetworkMode } from "./network-mode.ts";

describe("network mode preference", () => {
  test("defaults invalid or missing preferences to auto", () => {
    expect(parseNetworkMode("auto")).toBe("auto");
    expect(parseNetworkMode("p2p")).toBe("p2p");
    expect(parseNetworkMode("relay")).toBe("relay");
    expect(parseNetworkMode("nope")).toBe("auto");
    expect(parseNetworkMode(null, "relay")).toBe("relay");
  });
});
