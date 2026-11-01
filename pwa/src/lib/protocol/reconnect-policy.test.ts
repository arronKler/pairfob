import { describe, expect, test } from "bun:test";
import { DAEMON_OFFLINE_MAX_MS, PATH_CHECK_FLOOR_MS, pathCheckDue, HELLO_WINDOW_MS, HelloBudget, RECONNECT_BASE_MS, RECONNECT_MAX_MS, STANDBY_HELLO_LIMIT, reconnectDelay, reconnectMax } from "./reconnect-policy.ts";

const sessionSource = await Bun.file(new URL("./session-ws.ts", import.meta.url)).text();

describe("mobile reconnect backoff", () => {
  test("uses bounded jitter around exponential backoff", () => {
    expect(reconnectDelay(0, () => 0)).toBe(Math.round(RECONNECT_BASE_MS * 0.8));
    expect(reconnectDelay(0, () => 1)).toBe(Math.round(RECONNECT_BASE_MS * 1.2));
    expect(reconnectDelay(3, () => 0.5)).toBe(RECONNECT_BASE_MS * 8);
    expect(reconnectDelay(99, () => 1)).toBe(RECONNECT_MAX_MS);
  });

  test("clamps bad random sources and negative attempts", () => {
    expect(reconnectDelay(-3, () => -10)).toBe(Math.round(RECONNECT_BASE_MS * 0.8));
    expect(reconnectDelay(0, () => 10)).toBe(Math.round(RECONNECT_BASE_MS * 1.2));
  });

  test("tries once immediately after an established session drops", () => {
    const start = sessionSource.indexOf("private onDisconnect(");
    const body = sessionSource.slice(start, sessionSource.indexOf("private scheduleReconnect(", start));
    expect(body).toContain("this.scheduleReconnect(true)");
  });

  test("a relay with no daemon attached backs off to a minute instead of every 15 s", () => {
    expect(reconnectMax("daemon_offline")).toBe(DAEMON_OFFLINE_MAX_MS);
    expect(reconnectMax("timeout")).toBe(RECONNECT_MAX_MS);
    expect(reconnectMax()).toBe(RECONNECT_MAX_MS);
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => reconnectDelay(attempt, () => 0.5, reconnectMax("daemon_offline")));
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(reconnectDelay(8, () => 0.5)).toBe(RECONNECT_MAX_MS);
  });

  test("a failed dial's code chooses the ceiling for the next one", () => {
    const body = sessionSource.slice(sessionSource.indexOf("private scheduleReconnect("));
    expect(body).toContain("reconnectMax(this.lastConnectCode)");
    expect(body).toContain("this.lastConnectCode = protocolError.code");
  });
});

describe("read timeout path check", () => {
  test("checks the path at most once per floor, and never while one is running or after a stop", () => {
    expect(pathCheckDue(true, false, 0, 5_000)).toBe(true);
    expect(pathCheckDue(true, false, 5_000, 5_000 + PATH_CHECK_FLOOR_MS - 1)).toBe(false);
    expect(pathCheckDue(true, false, 5_000, 5_000 + PATH_CHECK_FLOOR_MS)).toBe(true);
    expect(pathCheckDue(true, true, 0, 5_000)).toBe(false);
    expect(pathCheckDue(false, false, 0, 5_000)).toBe(false);
  });
});

describe("handshake budget", () => {
  test("a standby may only spend while dials that must happen keep most of the minute", () => {
    // The computer admits ten DeviceHello1 per device a minute.
    expect(STANDBY_HELLO_LIMIT).toBeLessThanOrEqual(5);
    const budget = new HelloBudget();
    for (let i = 0; i < STANDBY_HELLO_LIMIT; i++) {
      expect(budget.spare(1_000 + i)).toBe(true);
      budget.spend(1_000 + i);
    }
    expect(budget.spare(2_000)).toBe(false);
    expect(budget.spare(999 + HELLO_WINDOW_MS)).toBe(false);
    expect(budget.spare(1_000 + HELLO_WINDOW_MS)).toBe(true);
  });

  test("a clock that moved backwards cannot hide what was spent", () => {
    const budget = new HelloBudget();
    for (let i = 0; i < STANDBY_HELLO_LIMIT; i++) budget.spend(50_000);
    expect(budget.spare(49_000)).toBe(false);
  });
});
