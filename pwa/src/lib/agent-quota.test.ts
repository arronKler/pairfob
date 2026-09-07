import { describe, expect, test } from "bun:test";
import { parseAgentQuota, quotaIsStale } from "./agent-quota";

const item = { provider: "codex", plan: "pro", status: "ok", source: "app_server", observed_at: 1800000000,
  windows: [{ name: "codex", used_percent: 0, window_minutes: 300, resets_at: 1800001000 }] };
describe("account quota boundary", () => {
  test("zero use is valid, no account totals are inferred", () => {
    expect(parseAgentQuota({ items: [item] })[0]?.windows[0]?.used_percent).toBe(0);
  });
  test("rejects missing, duplicate and invalid percentages", () => {
    for (const value of [null, {}, { items: [item, item] }, { items: [{ ...item, windows: [] }] },
      ...[NaN, -1, 101, "25", null].map((v) => ({ items: [{ ...item, windows: [{ ...item.windows[0], used_percent: v }] }] }))]) {
      expect(() => parseAgentQuota(value)).toThrow();
    }
  });
  test("reset and freshness are checked again at display time", () => {
    const q = parseAgentQuota({ items: [item] })[0]!;
    expect(quotaIsStale(q, 1800000100_000)).toBe(false);
    expect(quotaIsStale(q, 1800001000_000)).toBe(true);
    expect(quotaIsStale({ ...q, windows: [{ ...q.windows[0]!, resets_at: 1900000000 }] }, 1800000900_000)).toBe(true);
  });
});

test("supports six providers, unlimited and unknown resets but excludes Gemini CLI", () => {
  const providers = ["codex", "claude", "antigravity", "copilot", "cursor", "grok"];
  const sources = ["app_server", "oauth", "local_api", "github_api", "web_api", "oauth"];
  const items = providers.map((provider, i) => ({ ...item, provider, source: sources[i], windows: [{ ...item.windows[0], resets_at: 0, unlimited: true }] }));
  const parsed = parseAgentQuota({ items });
  expect(parsed).toHaveLength(6);
  expect(quotaIsStale(parsed[0]!, 1800000100_000)).toBe(false);
  expect(() => parseAgentQuota({ items: [{ ...items[0], provider: "gemini" }] })).toThrow();
  expect(() => parseAgentQuota({ items: [{ ...items[0], windows: [{ ...items[0]!.windows[0], used_percent: 20 }] }] })).toThrow();
});
