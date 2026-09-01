import { describe, expect, test } from "bun:test";
import { DirectSessionDriver, type DirectSessionHost } from "./session-direct.ts";

describe("direct attempt lifecycle", () => {
  test("dispose aborts an in-flight attempt but leaves it authoritative until it settles", () => {
    const host = {} as DirectSessionHost;
    const driver = new DirectSessionDriver(host);
    const pending = new Promise<void>(() => undefined);
    const internals = driver as unknown as { directAttempt: Promise<void> | null };
    internals.directAttempt = pending;

    driver.dispose();

    expect(internals.directAttempt).toBe(pending);
  });
});
