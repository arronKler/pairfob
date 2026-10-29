import { describe, expect, test } from "bun:test";
import { parseQuotaAccounts } from "./agent-quota-v2";

const share = { kind: "quota", name: "codex", pool: "plan", headline: true, used_percent: 0, window_minutes: 300, resets_at: 1800001000 };
const ok = { id: "codex", provider: "codex", plan: "pro", state: "ok", observed_at: 1800000000, meters: [share] };
const one = (patch: object) => ({ items: [{ ...ok, ...patch }] });
const meters = (...list: object[]) => one({ meters: list });

describe("AgentQuotaV2 boundary", () => {
  test("zero use is valid and fields left off the wire read as zero or empty", () => {
    const { accounts, unknown } = parseQuotaAccounts(meters({ kind: "quota", name: "chat", pool: "chat", used_percent: 0 }));
    expect(unknown).toBe(0);
    expect(accounts[0]).toEqual({
      id: "codex", provider: "codex", plan: "pro", scope: "", region: "", label: "", source: "", state: "ok", reason: "",
      observed_at: 1800000000, retry_at: 0,
      meters: [{ kind: "quota", name: "chat", pool: "chat", headline: false, used_percent: 0, count: null, window_minutes: 0, resets_at: 0 }],
    });
  });

  test("every meter kind decodes with the fields of its own kind only", () => {
    const { accounts } = parseQuotaAccounts(one({ state: "partial", scope: "org", region: "cn", label: "work", source: "oauth", meters: [
      { ...share, used: 188, limit: 500, unit: "requests" },
      { kind: "balance", name: "top up", pool: "top-up", amount: 1240, scale: 2, unit: "usd" },
      { kind: "level", name: "opus", pool: "model", headline: true, level: "low" },
      { kind: "unlimited", name: "completions", pool: "completions", resets_at: 1800001000 },
      { kind: "unread", name: "credits", pool: "credits" },
    ] }));
    const account = accounts[0]!;
    expect([account.scope, account.region, account.label, account.source]).toEqual(["org", "cn", "work", "oauth"]);
    expect(account.meters.map(meter => meter.kind)).toEqual(["quota", "balance", "level", "unlimited", "unread"]);
    expect(account.meters[0]).toMatchObject({ count: { used: 188, limit: 500, scale: 0, unit: "requests" } });
    expect(account.meters[1]).toMatchObject({ amount: 1240, scale: 2, unit: "usd", headline: false });
    expect(account.meters[2]).toMatchObject({ level: "low", headline: true });
  });

  test("rejects a meter that is missing, out of range or carries another kind's field", () => {
    for (const bad of [
      { ...share, used_percent: undefined }, { ...share, used_percent: 101 }, { ...share, used_percent: -1 }, { ...share, used_percent: "25" },
      { ...share, used_percent: NaN }, { ...share, name: "" }, { ...share, pool: "Plan A" }, { ...share, headline: false },
      { ...share, window_minutes: 0 }, { ...share, resets_at: 0 }, { ...share, resets_at: 4102444801 },
      { ...share, used: 1 }, { ...share, used: 1, limit: 0, unit: "requests" }, { ...share, used: 1, limit: 5, unit: "tokens" },
      { ...share, used: 1.5, limit: 5, unit: "requests" }, { ...share, level: "low" }, { ...share, amount: 3 }, { ...share, extra: 1 },
      { kind: "balance", name: "top up", pool: "top-up", unit: "usd" }, { kind: "balance", name: "top up", pool: "top-up", amount: -1, unit: "usd" },
      { kind: "balance", name: "top up", pool: "top-up", amount: 1, scale: 7, unit: "usd" }, { kind: "balance", name: "top up", pool: "top-up", amount: 1, unit: "usd", used_percent: 3 },
      { kind: "level", name: "opus", pool: "model", level: "plenty" }, { kind: "level", name: "opus", pool: "model" },
      { kind: "unlimited", name: "chat", pool: "chat", used_percent: 0 }, { kind: "unread", name: "chat", pool: "chat", headline: true },
      { kind: "gauge", name: "chat", pool: "chat" }, null, "quota",
    ]) {
      expect(() => parseQuotaAccounts(meters(bad as object))).toThrow();
    }
  });

  test("numbers come with a sample time, and only the states that can carry them do", () => {
    const failed = { state: "failed", reason: "timeout" };
    for (const good of [
      one({}), one({ ...failed, observed_at: 0, meters: [] }), one(failed), one({ state: "throttled", retry_at: 1800000600 }),
      one({ state: "throttled", observed_at: 0, meters: [] }), one({ state: "needs_action", reason: "relogin", observed_at: 0, meters: [] }),
      one({ state: "not_configured", reason: "not_running", observed_at: 0, meters: [] }),
    ]) {
      expect(parseQuotaAccounts(good).accounts).toHaveLength(1);
    }
    const unread = { kind: "unread", name: "credits", pool: "credits" };
    for (const bad of [
      one({ meters: [] }), one({ observed_at: 0 }), one({ ...failed, observed_at: 0 }), one({ ...failed, meters: [] }),
      one({ state: "needs_action", reason: "relogin" }), one({ state: "not_configured", reason: "no_login" }),
      // A state says why in its own words and no other's.
      one({ reason: "timeout" }), one({ state: "failed", observed_at: 0, meters: [] }), one({ state: "failed", reason: "relogin", observed_at: 0, meters: [] }),
      one({ state: "needs_action", reason: "not_running", observed_at: 0, meters: [] }), one({ state: "not_configured", reason: "sign_in", observed_at: 0, meters: [] }),
      one({ state: "waiting" }), one({ retry_at: 1800000600 }),
      // Part of a read is some meters read and some not: never none, never all.
      one({ state: "partial" }), one({ state: "partial", meters: [unread] }), one({ meters: [share, unread] }),
      one({ id: "Codex" }), one({ plan: "x".repeat(81) }), one({ scope: "team" }), one({ region: "CN" }), one({ label: "" }), one({ source: "App" }),
      one({ windows: [] }), one({ meters: Array(33).fill(share) }),
      { items: [ok, ok] }, { items: Array(65).fill(ok) }, { items: [ok], more: 1 }, { items: [null] }, { items: [{ ...ok, provider: 7 }] }, {}, null,
    ]) {
      expect(() => parseQuotaAccounts(bad)).toThrow();
    }
  });

  test("DeepSeek is an account with a cash balance, not a percentage window", () => {
    const balance = { kind: "balance", name: "balance", pool: "cny", headline: true, amount: 21139, scale: 2, unit: "cny" };
    const { accounts, unknown } = parseQuotaAccounts(one({ id: "deepseek", provider: "deepseek", plan: "", source: "api", meters: [balance] }));
    expect(unknown).toBe(0);
    expect(accounts[0]!.meters[0]).toMatchObject({ kind: "balance", amount: 21139, scale: 2, unit: "cny", headline: true });
  });

  test("OpenCode Go and Command Code keep their windows and dollar counts", () => {
    const window = { kind: "quota", name: "five hour", pool: "plan", headline: true, used_percent: 7, used: 98, limit: 1400, scale: 2, unit: "usd", window_minutes: 300, resets_at: 1800001000 };
    const monthly = { kind: "balance", name: "monthly balance", pool: "usd", headline: true, amount: 5343, scale: 2, unit: "usd", resets_at: 1800002000 };
    const { accounts, unknown } = parseQuotaAccounts({ items: [
      { ...ok, id: "opencode-go", provider: "opencode-go", plan: "", source: "api", meters: [
        { kind: "quota", name: "five hour", pool: "plan", headline: true, used_percent: 12.5, window_minutes: 300, resets_at: 1800001000 },
        { kind: "quota", name: "seven day", pool: "plan", headline: true, used_percent: 83, window_minutes: 10080, resets_at: 1800001000 },
        { kind: "quota", name: "monthly", pool: "plan", headline: true, used_percent: 100, resets_at: 1800001000 },
      ] },
      { ...ok, id: "command-code", provider: "command-code", plan: "Individual Goat", source: "api", meters: [window, monthly] },
    ] });
    expect(unknown).toBe(0);
    expect(accounts.map(account => [account.id, account.plan]))
      .toEqual([["opencode-go", ""], ["command-code", "Individual Goat"]]);
    expect(accounts[0]!.meters.map(meter => [meter.name, meter.window_minutes, meter.resets_at]))
      .toEqual([["five hour", 300, 1800001000], ["seven day", 10080, 1800001000], ["monthly", 0, 1800001000]]);
    expect(accounts[1]!.meters[0]).toMatchObject({ count: { used: 98, limit: 1400, scale: 2, unit: "usd" } });
    expect(accounts[1]!.meters[1]).toMatchObject({ kind: "balance", name: "monthly balance", amount: 5343, unit: "usd", resets_at: 1800002000 });
  });

  test("an account of a provider this build cannot name is left out, and the rest still show", () => {
    const later = { ...ok, id: "kimi-1", provider: "kimi", meters: [{ kind: "tokens", name: "a kind from the future", pool: "x" }] };
    const { accounts, unknown } = parseQuotaAccounts({ items: [later, ok, { ...later, id: "kimi-2" }] });
    expect(accounts.map(account => account.id)).toEqual(["codex"]);
    expect(unknown).toBe(2);
    // Several accounts of one provider are told apart by id alone.
    expect(parseQuotaAccounts({ items: [ok, { ...ok, id: "codex-team" }] }).accounts).toHaveLength(2);
  });
});
