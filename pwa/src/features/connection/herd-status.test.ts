import { describe, expect, test } from "bun:test";
import { t } from "../../lib/i18n";
import { canInterruptAgentWith, herdLivenessOf, herdStatusOf, type HerdStatusInput } from "./herd-status";

/**
 * The runtime-status model takes explicit inputs, so it is testable with no
 * application state, no DOM and no session object. These pin the frozen
 * semantics: loss of contact is never process death, and interrupt is a mutation
 * that only a live, currently-working agent may offer.
 */

function input(overrides: Partial<HerdStatusInput> = {}): HerdStatusInput {
  return { connected: true, networkOnline: true, runtimeKind: "herdr", herdHost: "", ...overrides };
}

describe("connection runtime status model", () => {
  test("only a connected session that reports runtime=offline proves Herdr exited", () => {
    expect(herdLivenessOf(input())).toBe("live");
    expect(herdLivenessOf(input({ runtimeKind: "fake" }))).toBe("live");
    expect(herdLivenessOf(input({ runtimeKind: "offline" }))).toBe("exited");
    expect(herdLivenessOf(input({ runtimeKind: "" }))).toBe("unverifiable");
    expect(herdLivenessOf(input({ connected: false }))).toBe("unverifiable");
    expect(herdLivenessOf(input({ networkOnline: false }))).toBe("unverifiable");
    // A dropped socket with a last-known offline runtime is still only unverifiable.
    expect(herdLivenessOf(input({ connected: false, runtimeKind: "offline" }))).toBe("unverifiable");
  });

  test("the phone's own network outranks every other verdict", () => {
    expect(herdStatusOf(input({ networkOnline: false })))
      .toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusOf(input({ networkOnline: false, runtimeKind: "offline" })))
      .toEqual({ tone: "warn", text: t("chrome.networkOffline") });
  });

  test("unverifiable separates a live socket from a reconnecting one", () => {
    expect(herdStatusOf(input({ runtimeKind: "", connected: true })))
      .toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(herdStatusOf(input({ runtimeKind: "", connected: false })))
      .toEqual({ tone: "warn", text: t("chrome.reconnecting") });
  });

  test("an exited runtime, a demo runtime and a named host each get their own copy", () => {
    expect(herdStatusOf(input({ runtimeKind: "offline" })))
      .toEqual({ tone: "off", text: t("chrome.herdrOff") });
    expect(herdStatusOf(input({ runtimeKind: "fake" })))
      .toEqual({ tone: "demo", text: t("chrome.demo") });
    expect(herdStatusOf(input({ herdHost: "MacBook Pro" })))
      .toEqual({ tone: "live", text: t("chrome.connectedHost", { host: "MacBook Pro" }) });
    expect(herdStatusOf(input())).toEqual({ tone: "live", text: t("chrome.connected") });
  });

  test("interrupt needs a working agent on a live runtime", () => {
    expect(canInterruptAgentWith("working", "live")).toBeTrue();
    expect(canInterruptAgentWith("working", "unverifiable")).toBeFalse();
    expect(canInterruptAgentWith("working", "exited")).toBeFalse();
    expect(canInterruptAgentWith("idle", "live")).toBeFalse();
    expect(canInterruptAgentWith("", "live")).toBeFalse();
  });
});

test("checking is neutral even with a stale live runtime and yields to network loss", () => {
  expect(herdStatusOf({ ...input(), connected: false, checking: true }))
    .toEqual({ tone: "pending", text: t("chrome.checking") });
  expect(herdStatusOf({ ...input(), checking: true, networkOnline: false }).text)
    .toBe(t("chrome.networkOffline"));
});
