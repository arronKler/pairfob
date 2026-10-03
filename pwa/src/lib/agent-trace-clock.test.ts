import { afterEach, expect, test } from "bun:test";
import { daemonNow, noteDaemonClock } from "./agent-trace-clock";

afterEach(() => noteDaemonClock(0, 0));

test("the computer's clock is the phone's clock plus the last observed offset", () => {
  // The computer runs 90 s ahead of the phone.
  noteDaemonClock(1_000_090_000, 1_000_000_000);
  expect(daemonNow(1_000_005_000)).toBe(1_000_095_000);
});
