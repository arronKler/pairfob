import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";

await resetBoardTestDOM();
Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
const telemetry = await import("../lib/telemetry");
telemetry.setTelemetrySender(() => {});

const { startApplication, stopApplication, applicationIsRunning } = await import("./bootstrap");
const { subscribeAppFrame, getAppFrame, sessionOwnerPreparer, registerSessionOwnerPreparer } = await import("./frame");
const { registerSessionView } = await import("../features/session/register");
const { appHost } = await import("./host");

afterEach(async () => {
  registerSessionOwnerPreparer(null);
  if (applicationIsRunning()) await act(async () => { stopApplication(); });
  telemetry.resetTelemetry();
});

/**
 * Bootstrap session-owner registration survives replacement startups.
 *
 * Regression: old stop ran unmountApp(), whose retired-frame publication let a
 * frame subscriber start a replacement application, and then unconditionally
 * called registerSessionOwnerPreparer(null) — clearing the seam the replacement
 * had just installed (the same registerSessionView function, so function
 * equality cannot distinguish the two lifetimes). The registration is owned by
 * the startup lifetime and must be retired before the teardown publications, so
 * a stopped lifecycle never unregisters its replacement.
 */
test("bootstrap stop cannot clear a replacement startup session-owner registration after a teardown notification", async () => {
  registerSessionOwnerPreparer(null);
  let firstStop!: () => void;
  act(() => { firstStop = startApplication(); });
  expect(sessionOwnerPreparer()).toBe(registerSessionView);
  let replacementStop: (() => void) | undefined;
  let once = false;
  let duringRestart = false;
  const off = subscribeAppFrame(() => {
    if (once || getAppFrame().layout !== null) return;
    once = true;
    replacementStop = startApplication();
    duringRestart = sessionOwnerPreparer() === registerSessionView;
  });
  let result: unknown;
  try {
    act(() => { firstStop(); });
    result = {
      restarted: once,
      duringRestart,
      running: applicationIsRunning(),
      host: appHost() !== null,
      preparerPreserved: sessionOwnerPreparer() === registerSessionView,
    };
  } finally {
    off();
    await act(async () => { replacementStop?.(); stopApplication(); });
    registerSessionOwnerPreparer(null);
    telemetry.resetTelemetry();
    await happy.happyDOM.abort();
  }
  expect(result).toEqual({ restarted: true, duringRestart: true, running: true, host: true, preparerPreserved: true });
});