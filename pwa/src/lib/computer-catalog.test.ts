import { describe, expect, test } from "bun:test";
import {
  computerDisplayName,
  computerTitle,
  credentialIsBurned,
  phaseAfterComputers,
  pickResumeCredential,
  sortComputers,
  validComputerAlias,
  withCarriedAlias,
} from "./computer-catalog.ts";
import type { PairResult } from "./protocol/client.ts";

function pair(daemonId: string, extra: Partial<PairResult> = {}): PairResult {
  return {
    daemonId,
    deviceId: "dev_abcdefgh",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    fp: "fp",
    relayOrigin: "https://pairfob.com",
    label: "iPhone",
    createdAt: 10,
    ...extra,
  };
}

describe("computer catalog", () => {
  test("resumes the last-used daemon when it is still stored", () => {
    const laptop = pair("d_0123456789abcdefaaaa", { createdAt: 30, hostname: "laptop" });
    const desk = pair("d_0123456789abcdefbbbb", { createdAt: 90, hostname: "desk" });
    expect(pickResumeCredential([laptop, desk], laptop.daemonId)?.daemonId).toBe(laptop.daemonId);
    expect(pickResumeCredential([laptop, desk], "d_0123456789abcdefcccc")?.daemonId).toBe(desk.daemonId);
    expect(pickResumeCredential([], laptop.daemonId)).toBeNull();
  });

  test("sorts last-used first, then most recently seen", () => {
    const older = pair("d_0123456789abcdefaaaa", { lastSeen: 10, hostname: "old" });
    const newer = pair("d_0123456789abcdefbbbb", { lastSeen: 50, hostname: "new" });
    const used = pair("d_0123456789abcdefcccc", { lastSeen: 1, hostname: "used" });
    expect(sortComputers([older, newer, used], used.daemonId).map((item) => item.hostname)).toEqual([
      "used",
      "new",
      "old",
    ]);
  });

  test("titles fall back without inventing a hostname", () => {
    expect(computerTitle(pair("d_0123456789abcdefaaaa", { hostname: "studio" }))).toBe("studio");
    expect(computerTitle(pair("d_0123456789abcdefaaaa"))).toBe("未命名电脑");
    expect(computerTitle(pair("d_0123456789abcdefaaaa", { hostname: "  " }))).toBe("未命名电脑");
  });

  test("this browser's alias names the computer before its hostname", () => {
    expect(computerTitle(pair("d_0123456789abcdefaaaa", { hostname: "studio", alias: " Studio Mac " }))).toBe("Studio Mac");
    expect(computerTitle(pair("d_0123456789abcdefaaaa", { hostname: "studio", alias: "   " }))).toBe("studio");
  });

  test("display names prefer the alias, then the reported host, then the saved name", () => {
    const aliased = pair("d_0123456789abcdefaaaa", { hostname: "studio", alias: "Studio Mac" });
    const saved = pair("d_0123456789abcdefaaaa", { hostname: "studio" });
    expect(computerDisplayName(aliased, "Studio-Display")).toBe("Studio Mac");
    expect(computerDisplayName(saved, " Studio-Display ")).toBe("Studio-Display");
    expect(computerDisplayName(saved, "")).toBe("studio");
    expect(computerDisplayName(null, "Studio-Display")).toBe("Studio-Display");
    expect(computerDisplayName(null, "")).toBe("当前电脑");
    expect(computerDisplayName(pair("d_0123456789abcdefaaaa"))).toBe("未命名电脑");
    expect(computerDisplayName(null)).toBe("当前电脑");
  });

  test("re-pairing keeps the name this browser already used", () => {
    const existing = pair("d_0123456789abcdefaaaa", { alias: "Studio Mac" });
    const fresh = pair("d_0123456789abcdefaaaa", { hostname: "studio" });
    expect(withCarriedAlias(fresh, existing).alias).toBe("Studio Mac");
    expect("alias" in withCarriedAlias(fresh, null)).toBeFalse();
    expect("alias" in withCarriedAlias(fresh, pair("d_0123456789abcdefaaaa", { alias: "  " }))).toBeFalse();
    expect(withCarriedAlias(pair("d_0123456789abcdefaaaa", { alias: "New" }), existing).alias).toBe("New");
  });

  test("alias rules: blank is valid, 64 runes is the cap, control characters are not", () => {
    expect(validComputerAlias("")).toBeTrue();
    expect(validComputerAlias("   ")).toBeTrue();
    expect(validComputerAlias("a".repeat(64))).toBeTrue();
    expect(validComputerAlias("a".repeat(65))).toBeFalse();
    expect(validComputerAlias("studio\nlab")).toBeFalse();
    expect(validComputerAlias("studio\u009flab")).toBeFalse();
    expect(validComputerAlias("😀".repeat(64))).toBeTrue();
    expect(validComputerAlias("😀".repeat(65))).toBeFalse();
  });

  test("only burns credentials that the daemon rejected", () => {
    expect(credentialIsBurned("revoked")).toBe(true);
    expect(credentialIsBurned("unpaired")).toBe(true);
    expect(credentialIsBurned("invalid_credential")).toBe(true);
    expect(credentialIsBurned("daemon_offline")).toBe(false);
    expect(credentialIsBurned("kicked")).toBe(false);
    expect(credentialIsBurned("too_many_devices")).toBe(false);
    expect(credentialIsBurned("ws_open_failed")).toBe(false);
    // Relay and transport liveness failures keep the saved computer.
    expect(credentialIsBurned("timeout")).toBe(false);
    expect(credentialIsBurned("bad_frame")).toBe(false);
    expect(credentialIsBurned("bad_message")).toBe(false);
    expect(phaseAfterComputers(2)).toBe("pick");
    expect(phaseAfterComputers(0)).toBe("connect");
  });
});
