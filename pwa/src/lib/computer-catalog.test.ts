import { describe, expect, test } from "bun:test";
import {
  computerTitle,
  credentialIsBurned,
  phaseAfterComputers,
  pickResumeCredential,
  sortComputers,
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

  test("only burns credentials that the daemon rejected", () => {
    expect(credentialIsBurned("revoked")).toBe(true);
    expect(credentialIsBurned("unpaired")).toBe(true);
    expect(credentialIsBurned("invalid_credential")).toBe(true);
    expect(credentialIsBurned("daemon_offline")).toBe(false);
    expect(credentialIsBurned("kicked")).toBe(false);
    expect(credentialIsBurned("too_many_devices")).toBe(false);
    expect(credentialIsBurned("ws_open_failed")).toBe(false);
    expect(phaseAfterComputers(2)).toBe("pick");
    expect(phaseAfterComputers(0)).toBe("connect");
  });
});
