import { beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../test-support/boot-dom";
import { quotaAccount, quotaOff, quotaShare } from "../../test-support/quota";
import type { QuotaAccount } from "./agent-quota-v2";
import { clearQuotaCache, loadQuotaCache, resetQuotaCache, saveQuotaCache } from "./quota-cache";

/**
 * The answer kept for the next app start. It is written in the wire shape and
 * read back through the strict decoder, so a record this build can no longer
 * name is dropped instead of drawn.
 */

const DAEMON = "d_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "d_bbbbbbbbbbbbbbbbbbbb";

const accounts = (): QuotaAccount[] => [
  quotaAccount({ id: "codex", provider: "codex", plan: "Pro", meters: [quotaShare()] }),
  quotaAccount({ id: "deepseek", provider: "deepseek", plan: "", source: "api", meters: [
    { kind: "balance", name: "balance", pool: "cny", headline: true, amount: 21139, scale: 2, unit: "cny", window_minutes: 0, resets_at: 0 },
  ] }),
  quotaOff("grok", "needs_action", "relogin"),
];

beforeEach(async () => {
  await resetTestDOM();
  resetQuotaCache();
});

describe("quota answer kept on the phone", () => {
  test("round-trips accounts, meters, the legacy mark and the unknown count", () => {
    // One sample for both sides: observed_at comes from the clock, so a second
    // call could land in the next second and compare two different reads.
    const items = accounts();
    saveQuotaCache(DAEMON, { items, legacy: true, unknown: 2 });
    expect(loadQuotaCache(DAEMON)).toEqual({ items, legacy: true, unknown: 2 });
  });

  test("a record that no longer fits the schema is dropped instead of drawn", () => {
    saveQuotaCache(DAEMON, { items: accounts(), legacy: false, unknown: 0 });
    const key = "pairfob.quota.v1." + DAEMON;
    for (const raw of [
      "{", "null", JSON.stringify({ v: 2, items: [] }),
      JSON.stringify({ v: 1, items: [{ id: "codex" }] }),
      JSON.stringify({ v: 1, items: [{ ...quotaAccount(), state: "waiting" }] }),
      JSON.stringify({ v: 1, items: Array(65).fill(quotaAccount()) }),
    ]) {
      localStorage.setItem(key, raw);
      expect(loadQuotaCache(DAEMON)).toBeNull();
    }
  });

  test("a provider this build cannot name is left out and counted", () => {
    const later = { ...quotaAccount({ id: "kimi", provider: "codex" }), provider: "kimi" };
    saveQuotaCache(DAEMON, { items: [accounts()[0]!, later as QuotaAccount], legacy: false, unknown: 1 });
    expect(loadQuotaCache(DAEMON)).toMatchObject({ unknown: 2 });
    expect(loadQuotaCache(DAEMON)?.items.map(account => account.id)).toEqual(["codex"]);
  });

  test("one computer's answer is not another's, and forgetting one leaves the other", () => {
    saveQuotaCache(DAEMON, { items: accounts(), legacy: false, unknown: 0 });
    saveQuotaCache(OTHER, { items: [accounts()[0]!], legacy: false, unknown: 0 });
    clearQuotaCache(DAEMON);
    expect(loadQuotaCache(DAEMON)).toBeNull();
    expect(loadQuotaCache(OTHER)?.items).toHaveLength(1);
    resetQuotaCache();
    expect(loadQuotaCache(OTHER)).toBeNull();
  });

  test("a daemon id that cannot name a key is not stored or read", () => {
    saveQuotaCache("../escape", { items: accounts(), legacy: false, unknown: 0 });
    expect(loadQuotaCache("../escape")).toBeNull();
    expect([...Array(localStorage.length).keys()].map(index => localStorage.key(index))
      .filter(name => name?.startsWith("pairfob.quota."))).toEqual([]);
  });
});
