import { describe, expect, test } from "bun:test";
import { normalizePairInput, ProtocolError } from "./protocol/client.ts";
import {
  PAIR_CODE_PATTERN,
  PAIR_CODE_WITH_LOCATOR_PATTERN,
  fragmentUsableOnOrigin,
  parseCodeAndLocator,
  parsePairingCode,
  parsePairingFragment,
  parsePairingURL,
  parsePairLocator,
  resolveHandPairing,
} from "./pairing-input.ts";

const V1 = "#v=1&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M-9H2P&fp=AAAAAAAAAAAAAAAAAAAAAA";
const V2 = "#v=2&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M-9H2P&fp=AAAAAAAAAAAAAAAAAAAAAA";

describe("pair input validation", () => {
  test("HTML patterns compile under the browser v flag", () => {
    expect(() => new RegExp(`^(?:${PAIR_CODE_PATTERN})$`, "v")).not.toThrow();
    expect(() => new RegExp(`^(?:${PAIR_CODE_WITH_LOCATOR_PATTERN})$`, "v")).not.toThrow();
    expect(new RegExp(`^(?:${PAIR_CODE_PATTERN})$`, "v").test("7K3M-9H2P")).toBe(true);
    expect(new RegExp(`^(?:${PAIR_CODE_WITH_LOCATOR_PATTERN})$`, "v").test("7K3M-9H2P WJ3K9M")).toBe(true);
  });

  test("normalizes separators and ambiguous Crockford glyphs", () => {
    expect(normalizePairInput({}, "oilu-2345")).toEqual({
      input: { pair_ref: undefined },
      code: "011V2345",
    });
  });

  test("rejects wrong lengths before connecting", () => {
    expect(() => normalizePairInput({}, "ABC")).toThrow(ProtocolError);
    expect(() => normalizePairInput({ pair_ref: "bad" }, "ABCDEFGH")).toThrow(ProtocolError);
  });

  test("accepts one formatted pairing code", () => {
    expect(parsePairingCode("7k3m-9h2p")).toBe("7K3M9H2P");
    expect(parsePairingCode("onlyone")).toBeNull();
  });

  test("parses a 6-char locator with the same Crockford alphabet", () => {
    expect(parsePairLocator("wj3k9m")).toBe("WJ3K9M");
    expect(parsePairLocator("oilu12")).toBe("011V12");
    expect(parsePairLocator("SHORT")).toBeNull();
    expect(parsePairLocator("7K3M9H2P")).toBeNull();
  });

  test("parses CODE LOC clipboard blobs", () => {
    expect(parseCodeAndLocator("7K3M-9H2P WJ3K9M")).toEqual({ code: "7K3M9H2P", loc: "WJ3K9M" });
    expect(parseCodeAndLocator("7K3M9H2P")).toBeNull();
  });

  test("parses valid QR fragment and rejects query-shaped junk", () => {
    const valid = parsePairingFragment(V1);
    expect(valid).toEqual({
      v: 1,
      pairRef: "4f7a2c9e1b0d88aa55cc3311abde7001",
      code: "7K3M9H2P",
      daemonId: "d_0123456789abcdefabcd",
      fingerprint: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(parsePairingFragment("#v=1&r=bad&c=7K3M9H2P")).toBeNull();
    expect(parsePairingURL(`https://pairfob.example/pair${V1}`, "https://pairfob.example")).toEqual(valid);
    expect(parsePairingURL(`https://pairfob.example/pair/${V1}`, "https://pairfob.example")).toEqual(valid);
    expect(parsePairingURL("https://evil.example/pair#v=1", "https://pairfob.example")).toBeNull();
  });

  test("parses v=2 fragments with optional loc and required d,r,c,fp", () => {
    expect(parsePairingFragment(V2)).toEqual({
      v: 2,
      pairRef: "4f7a2c9e1b0d88aa55cc3311abde7001",
      code: "7K3M9H2P",
      daemonId: "d_0123456789abcdefabcd",
      fingerprint: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(parsePairingFragment(`${V2}&loc=WJ3K9M`)).toMatchObject({ v: 2, loc: "WJ3K9M", code: "7K3M9H2P" });
    expect(parsePairingFragment("#v=2&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M9H2P&fp=AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(parsePairingFragment("#v=2&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M9H2P")).toBeNull();
  });

  test("v=1 fragments stay usable only on protocol 1 origins", () => {
    const v1 = parsePairingFragment(V1)!;
    const v2 = parsePairingFragment(V2)!;
    expect(fragmentUsableOnOrigin(v1, 1)).toBe(true);
    expect(fragmentUsableOnOrigin(v1, 2)).toBe(false);
    expect(fragmentUsableOnOrigin(v2, 2)).toBe(true);
    expect(fragmentUsableOnOrigin(v2, 1)).toBe(false);
  });
});

describe("hand-entry locator gate", () => {
  test("protocol 2 requires one complete user-facing code locally", () => {
    expect(resolveHandPairing(2, "7K3M9H2P", false)).toEqual({
      ok: false,
      field: "code",
      error: "locator_required",
    });
    expect(resolveHandPairing(2, "7K3M-9H2P-WJ3K9M", false)).toEqual({
      ok: true,
      code: "7K3M9H2P",
      loc: "WJ3K9M",
    });
  });

  test("QR path on protocol 2 does not require loc", () => {
    expect(resolveHandPairing(2, "7K3M9H2P", true)).toEqual({ ok: true, code: "7K3M9H2P" });
  });

  test("protocol 1 still accepts a single 8-char code", () => {
    expect(resolveHandPairing(1, "7K3M9H2P", false)).toEqual({ ok: true, code: "7K3M9H2P" });
    expect(resolveHandPairing(1, "ABC", false)).toEqual({ ok: false, field: "code", error: "invalid_pair_code" });
  });
});
