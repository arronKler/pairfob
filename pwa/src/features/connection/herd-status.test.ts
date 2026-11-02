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
  return { phase: "connected", networkOnline: true, runtimeKind: "herdr", herdHost: "", ...overrides };
}

describe("connection runtime status model", () => {
  test("only a connected session that reports runtime=offline proves Herdr exited", () => {
    expect(herdLivenessOf(input())).toBe("live");
    expect(herdLivenessOf(input({ runtimeKind: "fake" }))).toBe("live");
    expect(herdLivenessOf(input({ runtimeKind: "offline" }))).toBe("exited");
    expect(herdLivenessOf(input({ runtimeKind: "" }))).toBe("unverifiable");
    expect(herdLivenessOf(input({ phase: "disconnected" }))).toBe("unverifiable");
    expect(herdLivenessOf(input({ networkOnline: false }))).toBe("unverifiable");
    // A dropped socket with a last-known offline runtime is still only unverifiable.
    expect(herdLivenessOf(input({ phase: "disconnected", runtimeKind: "offline" }))).toBe("unverifiable");
  });

  test("the phone's own network outranks every other verdict", () => {
    expect(herdStatusOf(input({ networkOnline: false })))
      .toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusOf(input({ networkOnline: false, runtimeKind: "offline" })))
      .toEqual({ tone: "warn", text: t("chrome.networkOffline") });
    expect(herdStatusOf(input({ networkOnline: false, phase: "verifying" })))
      .toEqual({ tone: "warn", text: t("chrome.networkOffline") });
  });

  test("unverifiable separates a live socket from a reconnecting one", () => {
    expect(herdStatusOf(input({ runtimeKind: "", phase: "connected" })))
      .toEqual({ tone: "warn", text: t("chrome.unverifiable") });
    expect(herdStatusOf(input({ runtimeKind: "", phase: "disconnected" })))
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

test("verifying and connecting each get their own copy, and network loss outranks both", () => {
  expect(herdStatusOf(input({ phase: "verifying", runtimeKind: "offline" })))
    .toEqual({ tone: "pending", text: t("chrome.verifying") });
  expect(herdStatusOf(input({ phase: "connecting" })))
    .toEqual({ tone: "pending", text: t("chrome.checking") });
  expect(herdStatusOf(input({ phase: "verifying", networkOnline: false })).text)
    .toBe(t("chrome.networkOffline"));
  expect(herdStatusOf(input({ phase: "connecting", networkOnline: false })).text)
    .toBe(t("chrome.networkOffline"));
});

describe("the first runtime read", () => {
  test("an identity not read yet reads as reading, not as a fault", () => {
    expect(herdStatusOf(input({ runtimeKind: "", reading: true })))
      .toEqual({ tone: "pending", text: t("chrome.reading") });
    // The verdict itself stays unverifiable: nothing may be gated on a guess.
    expect(herdLivenessOf(input({ runtimeKind: "", reading: true }))).toBe("unverifiable");
  });

  test("once the read answers, failed, or runs out of time, the real verdict shows", () => {
    expect(herdStatusOf(input({ runtimeKind: "", reading: false })).text).toBe(t("chrome.unverifiable"));
    expect(herdStatusOf(input({ runtimeKind: "herdr", reading: true })).tone).toBe("live");
    // Offline and a dropped socket keep their own words while a read is pending.
    expect(herdStatusOf(input({ runtimeKind: "", reading: true, networkOnline: false })).text).toBe(t("chrome.networkOffline"));
    expect(herdStatusOf(input({ runtimeKind: "", reading: true, phase: "disconnected" })).text).toBe(t("chrome.reconnecting"));
  });
});
