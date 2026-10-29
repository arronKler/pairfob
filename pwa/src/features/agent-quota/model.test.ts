import { beforeEach, describe, expect, test } from "bun:test";
import { quotaAccount, quotaOff, quotaShare } from "../../../test-support/quota";
import { QUOTA_PROVIDERS, type QuotaAccount, type QuotaMeter } from "../../lib/agent-quota-v2";
import { setLang, t } from "../../lib/i18n";
import { agentIcon } from "../../shared/ui/primitives";
import {
  MODULE_ROWS, amountText, meterLabel, meterModel, orderAccounts, quotaCardModel, quotaGuidance, quotaModuleModel, quotaPanelModel,
  quotaRowModel, summaryMeter,
} from "./model";

/**
 * The quota projections: what stands for an account, what each kind of meter
 * paints, which of the page's three groups an account lands in, and which four
 * the settings module shows.
 */

const NOW = 1_800_000_000;
const at = (seconds: number) => NOW + seconds;
const share = (used: number, patch: Partial<Extract<QuotaMeter, { kind: "quota" }>> = {}) =>
  quotaShare({ used_percent: used, resets_at: at(3600), ...patch });
const account = (patch: Partial<QuotaAccount> = {}) => quotaAccount({ observed_at: at(-60), meters: [share(25)], ...patch });
const base = { pool: "x", headline: false, window_minutes: 0, resets_at: 0 };
const level = (value: "full" | "high" | "medium" | "low" | "empty", headline = false): QuotaMeter => ({ ...base, kind: "level", name: "model quota", level: value, headline });
const balance = (amount: number, headline = false): QuotaMeter => ({ ...base, kind: "balance", name: "top up", amount, scale: 2, unit: "usd", headline });
const unlimited = (headline = false): QuotaMeter => ({ ...base, kind: "unlimited", name: "completions", headline });
const snapshot = (...items: QuotaAccount[]) => ({ loading: false, items, error: "" });

beforeEach(() => setLang("zh"));

describe("the meter that stands for an account", () => {
  test("is the tightest of the meters the computer marked, and never one it did not", () => {
    const meters = [share(25), share(90, { name: "week" }), share(99, { name: "model", pool: "model", headline: false })];
    expect(summaryMeter(account({ meters }), NOW)?.name).toBe("week");
    // Copilot's chat and completions are not the plan: with nothing marked there is no number.
    expect(summaryMeter(account({ meters: [share(10, { headline: false }), share(20, { headline: false })] }), NOW)).toBeNull();
    // An account's only meter needs no mark to stand for it.
    expect(summaryMeter(account({ meters: [balance(1240)] }), NOW)?.kind).toBe("balance");
  });

  test("ranks a level beside a share, falls back to unlimited and then to a balance", () => {
    expect(summaryMeter(account({ meters: [share(60), level("low", true)] }), NOW)?.kind).toBe("level");
    expect(summaryMeter(account({ meters: [share(85), level("low", true)] }), NOW)?.kind).toBe("quota");
    expect(summaryMeter(account({ meters: [unlimited(true), balance(5, true)] }), NOW)?.kind).toBe("unlimited");
    expect(summaryMeter(account({ meters: [balance(5, true), share(10, { headline: false })] }), NOW)?.kind).toBe("balance");
  });

  test("is nothing when the sample is old, dated ahead, or every marked meter is past its reset", () => {
    expect(summaryMeter(account({ observed_at: at(-900) }), NOW)).toBeNull();
    expect(summaryMeter(account({ observed_at: at(120) }), NOW)).toBeNull();
    expect(summaryMeter(account({ observed_at: at(-899) }), NOW)).not.toBeNull();
    expect(summaryMeter(account({ meters: [share(25, { resets_at: at(-1) })] }), NOW)).toBeNull();
    // One meter past its reset does not take the rest of the account with it.
    expect(summaryMeter(account({ meters: [share(99, { resets_at: at(-1) }), share(40, { name: "week" })] }), NOW)?.name).toBe("week");
    expect(summaryMeter(quotaOff("grok", "needs_action", "relogin"), NOW)).toBeNull();
  });
});

describe("what a meter paints", () => {
  test("a share is a bar that turns yellow under 30% and red under 10%", () => {
    expect(meterModel("Codex", share(25, { resets_at: 0 }), NOW)).toEqual({ kind: "limited", remaining: 75, tone: "ok", aria: "Codex 5 小时：剩余 75%" });
    // A pointer resting on the meter gets the exact reset and the counts the row gives in short.
    expect(meterModel("Codex", share(25), NOW).hint).toMatch(/^\d+月\d+日 \d\d:\d\d 重置$/);
    const counted = share(38, { resets_at: 0, count: { used: 188, limit: 500, scale: 0, unit: "requests" } });
    expect(meterModel("Copilot", counted, NOW).hint).toBe("已用 188 / 500 次");
    expect(meterModel("Codex", share(71), NOW)).toMatchObject({ remaining: 29, tone: "warn" });
    expect(meterModel("Codex", share(91), NOW)).toMatchObject({ remaining: 9, tone: "error" });
    expect(meterModel("Codex", share(0), NOW)).toMatchObject({ remaining: 100, tone: "ok" });
  });

  test("a level is pips and a word, a balance a figure, and neither is a percentage", () => {
    expect(meterModel("Letta", level("low"), NOW)).toEqual({ kind: "level", pips: 1, word: "偏低", tone: "warn", aria: "Letta 模型额度：偏低" });
    expect(meterModel("Letta", level("empty"), NOW)).toMatchObject({ pips: 0, word: "用尽", tone: "error" });
    expect(meterModel("Letta", level("full"), NOW)).toMatchObject({ pips: 5, word: "充足", tone: "ok" });
    expect(meterModel("Nous", balance(1240), NOW)).toEqual({ kind: "balance", text: "$12.40", aria: "Nous 充值余额：$12.40" });
    const cash: QuotaMeter = { ...base, kind: "balance", name: "balance", amount: 21139, scale: 2, unit: "cny", headline: true };
    expect([meterLabel(cash), meterModel("DeepSeek", cash, NOW)]).toEqual(["余额", { kind: "balance", text: "¥211.39", aria: "DeepSeek 余额：¥211.39" }]);
    expect(amountText(128000, 2, "credits")).toBe("1,280.00 credits");
    expect(amountText(3050, 2, "cny")).toBe("¥30.50");
    expect(amountText(188, 0, "requests")).toBe("188 次");
    expect(meterModel("Copilot", unlimited(), NOW)).toEqual({ kind: "unlimited", aria: "Copilot 补全：无限额度" });
  });

  test("a meter past its reset, or one this read missed, shows no number at all", () => {
    const expired = quotaRowModel("Codex", share(40, { resets_at: at(-1) }), 0, NOW);
    expect(expired.meter).toEqual({ kind: "pending", text: "待刷新", aria: "Codex 5 小时：已过重置时间" });
    expect([expired.sub, expired.quiet, expired.low]).toEqual(["已过重置时间", true, false]);
    const unread = quotaRowModel("Nous", { ...base, kind: "unread", name: "top up" }, 1, NOW);
    expect(unread.meter).toMatchObject({ kind: "pending", text: "—" });
    expect([unread.label, unread.sub, unread.quiet]).toEqual(["充值余额", "这次没有读到", true]);
  });

  test("a row says when it resets, how much of what is left, or that it does not reset", () => {
    expect(quotaRowModel("Codex", share(25), 0, NOW).sub).toMatch(/^1 小时后重置 · \d\d:\d\d$/);
    expect(quotaRowModel("Codex", share(25, { resets_at: 0 }), 0, NOW).sub).toBe(t("quota.resetUnknown"));
    const counted = share(38, { name: "premium requests", window_minutes: 0, resets_at: at(18 * 86400), count: { used: 188, limit: 500, scale: 0, unit: "requests" } });
    expect(quotaRowModel("Copilot", counted, 0, NOW)).toMatchObject({ label: "高级请求", sub: "剩 312 / 500 次 · 18 天后重置" });
    expect(quotaRowModel("Nous", balance(1240), 0, NOW).sub).toBe("不随周期重置");
    expect(quotaRowModel("Letta", level("high"), 0, NOW).sub).toBe("厂商只给档位");
    expect(quotaRowModel("Copilot", unlimited(), 0, NOW).sub).toBe("无限额度");
    expect(quotaRowModel("Codex", share(75), 0, NOW).low).toBeTrue();
    expect(quotaRowModel("Letta", level("low"), 0, NOW).low).toBeTrue();
    expect(quotaRowModel("Nous", balance(1), 0, NOW).low).toBeFalse();
  });

  test("a plan's window is named by its span, anything else by what it meters", () => {
    expect(meterLabel(share(1))).toBe("5 小时");
    expect(meterLabel(share(1, { window_minutes: 10080 }))).toBe("7 天");
    expect(meterLabel(share(1, { window_minutes: 90 }))).toBe("90 分钟");
    expect(meterLabel(share(1, { name: "seven day opus", window_minutes: 10080, headline: false }))).toBe("Opus 7 天");
    expect(meterLabel(share(1, { name: "seven_day_opus", window_minutes: 10080, headline: false }))).toBe("Opus 7 天");
    expect(meterLabel(share(1, { name: "GPT-5.3-Codex-Spark", headline: false }))).toBe("GPT-5.3-Codex-Spark · 5 小时");
    expect(meterLabel(share(1, { name: "Included plan", window_minutes: 0 }))).toBe("套餐额度");
    expect(meterLabel(share(1, { name: "Gemini 3 Pro / High", window_minutes: 0 }))).toBe("Gemini 3 Pro / High");
    setLang("en");
    expect(meterLabel(share(1, { name: "premium interactions", window_minutes: 0 }))).toBe("Premium interactions");
  });
});

describe("the quota page's three groups", () => {
  const items = [
    account(),
    account({ id: "claude", provider: "claude", state: "partial", meters: [share(36), { ...base, kind: "unread", name: "top up" }] }),
    account({ id: "cursor", provider: "cursor", state: "failed", reason: "timeout", observed_at: at(-480) }),
    account({ id: "cursor-old", provider: "cursor", state: "failed", reason: "timeout", observed_at: at(-1000) }),
    quotaOff("copilot", "failed", "unavailable"),
    quotaOff("grok", "needs_action", "relogin"),
    quotaOff("antigravity", "not_configured", "not_running"),
  ];
  const panel = () => quotaPanelModel(snapshot(...items), true, [], NOW);

  test("numbers are cards, a login that cannot be read needs the reader, no trace of one is neither", () => {
    const model = panel();
    expect(model.cards.map(card => card.id)).toEqual(["codex", "claude", "cursor"]);
    // A kept sample too old to show is no card: the account needs a read that works.
    expect(model.attention.map(notice => notice.id)).toEqual(["copilot", "cursor-old", "grok"]);
    expect(model.others.map(notice => notice.id)).toEqual(["antigravity"]);
    expect(model.updated).toBe("1 分钟前更新");
    expect([model.pending, model.legacy, model.unknown, model.error]).toEqual([false, false, 0, null]);
  });

  test("a card says how old its numbers are and why, and old numbers are not shown", () => {
    const [codex, claude, cursor] = panel().cards;
    expect([codex!.status, codex!.troubled, codex!.tag, codex!.plan]).toEqual(["1 分钟前更新", false, null, "Pro"]);
    expect(claude!.tag).toEqual({ text: "部分" });
    expect(claude!.rows.map(row => row.meter.kind)).toEqual(["limited", "pending"]);
    expect([cursor!.status, cursor!.troubled]).toEqual(["8 分钟前的数据 · 这次读取超时", true]);
    const throttled = quotaCardModel(account({ state: "throttled", observed_at: at(-360), retry_at: at(170) }), NOW);
    expect([throttled.status, throttled.tag]).toEqual(["查询太频繁，3 分钟后可以再刷新", { text: "稍后再试", tone: "warn" }]);
    expect(quotaCardModel(account({ state: "throttled", observed_at: at(-360) }), NOW).status).toBe("查询太频繁，稍后再刷新");
    const stale = quotaCardModel(account({ observed_at: at(-3600) }), NOW);
    expect([stale.stale, stale.rows, stale.more, stale.tag]).toEqual([true, [], null, { text: "已过期", tone: "warn" }]);
    expect(quotaCardModel(account({ plan: "" }), NOW).plan).toBeNull();
  });

  test("a plan spelled as an identifier reads as a name, and one already cased is kept", () => {
    const plan = (name: string) => quotaCardModel(account({ plan: name }), NOW).plan;
    expect(["unified_ultra", "max", "pro+", "SuperGrok Heavy", "Team", "_"].map(plan))
      .toEqual(["Unified Ultra", "Max", "Pro+", "SuperGrok Heavy", "Team", null]);
  });

  test("the meters that are not the plan fold under a line that still says one is low", () => {
    const models = [share(10, { name: "seven day sonnet", headline: false }), share(88, { name: "seven day opus", headline: false }), unlimited()];
    const card = quotaCardModel(account({ meters: [share(61), ...models] }), NOW);
    expect(card.rows.map(row => row.label)).toEqual(["5 小时"]);
    expect(card.more).toMatchObject({ label: "其他额度 · 3 项", low: "1 项偏低" });
    expect(card.more!.rows.map(row => row.label)).toEqual(["Sonnet 7 天", "Opus 7 天", "补全"]);
    expect(quotaCardModel(account({ meters: [share(61), unlimited()] }), NOW).more!.low).toBeNull();
    // With nothing marked there is nothing to set aside: every meter is a row.
    const unmarked = quotaCardModel(account({ meters: [share(10, { name: "chat", headline: false }), unlimited()] }), NOW);
    expect([unmarked.rows.length, unmarked.more]).toEqual([2, null]);
  });

  test("a DeepSeek card is its balance, and says that balance does not reset", () => {
    const cash: QuotaMeter = { ...base, kind: "balance", name: "balance", amount: 21139, scale: 2, unit: "cny", headline: true };
    const card = quotaCardModel(account({ provider: "deepseek", plan: "", source: "api", meters: [cash] }), NOW);
    expect([card.title, card.plan, card.rows.map(row => [row.label, row.meter])])
      .toEqual(["DeepSeek", null, [["余额", { kind: "balance", text: "¥211.39", aria: "DeepSeek 余额：¥211.39" }]]]);
    expect(card.notes).toEqual([t("quota.deepseekNote")]);
  });

  test("OpenCode Go names its windows, and Command Code ends on its monthly balance", () => {
    const opencode = quotaCardModel(account({ id: "opencode-go", provider: "opencode-go", plan: "", source: "api", meters: [
      share(12.5, { name: "five hour", window_minutes: 300 }),
      share(83, { name: "seven day", window_minutes: 10080 }),
      share(100, { name: "monthly", window_minutes: 0 }),
    ] }), NOW);
    expect([opencode.title, opencode.rows.map(row => row.label)]).toEqual(["OpenCode Go", ["5 小时", "7 天", "月度窗口"]]);
    expect(opencode.notes).toEqual([t("quota.opencodeGoNote")]);

    const credits: QuotaMeter = { ...base, kind: "balance", name: "monthly balance", amount: 5343, scale: 2, unit: "usd", headline: true };
    const command = quotaCardModel(account({ id: "command-code", provider: "command-code", plan: "Individual Goat", source: "api", meters: [
      share(7, { name: "five hour", window_minutes: 300 }),
      credits,
    ] }), NOW);
    expect([command.title, command.plan, command.rows.map(row => row.label)])
      .toEqual(["Command Code", "Individual Goat", ["5 小时", "本月余额"]]);
    expect(command.rows[0]!.meter.kind).toBe("limited");
    expect(command.rows[1]!.meter).toEqual({ kind: "balance", text: "$53.43", aria: "Command Code 本月余额：$53.43" });
    expect(command.notes).toEqual([t("quota.commandCodeNote")]);
  });

  test("a second account of a provider says which one it is", () => {
    expect(quotaCardModel(account({ region: "cn" }), NOW).status).toBe("国内站 · 1 分钟前更新");
    expect(quotaCardModel(account({ region: "global", scope: "org", label: "acme" }), NOW).status).toBe("国际站 · 组织账户 · acme · 1 分钟前更新");
    expect(quotaCardModel(account({ region: "eu" }), NOW).status).toBe("EU · 1 分钟前更新");
    expect(quotaCardModel(account({ scope: "personal" }), NOW).status).toBe("1 分钟前更新");
  });

  test("the page follows the reader's order and never how much is left", () => {
    const ordered = quotaPanelModel(snapshot(...items), true, ["cursor", "claude"], NOW);
    expect(ordered.cards.map(card => card.id)).toEqual(["cursor", "claude", "codex"]);
    expect(orderAccounts([{ provider: "grok" as const }, { provider: "codex" as const }, { provider: "claude" as const }], ["grok"]).map(item => item.provider))
      .toEqual(["grok", "codex", "claude"]);
  });

  test("a failed refresh keeps what was read and says so; no answer yet is pending", () => {
    expect(quotaPanelModel({ ...snapshot(...items), error: "quota.failed" }, true, [], NOW)).toMatchObject({ error: t("quota.kept"), pending: false });
    expect(quotaPanelModel({ loading: false, items: null, error: "quota.failed" }, true)).toMatchObject({ error: t("quota.failed"), pending: true, cards: [] });
    expect(quotaPanelModel({ loading: false, items: null, error: "quota.upgrade" }, true).error).toBe(t("quota.upgrade"));
    expect(quotaPanelModel(undefined, false)).toMatchObject({ offline: true, pending: true, busy: false });
    expect(quotaPanelModel({ ...snapshot(), legacy: true, unknown: 2 }, true)).toMatchObject({ legacy: true, unknown: 2 });
  });
});

describe("what to do about an account without numbers", () => {
  const guide = (provider: QuotaAccount["provider"], state: "needs_action" | "not_configured" | "failed", reason: QuotaAccount["reason"], diagnose = true) =>
    quotaGuidance(quotaOff(provider, state, reason), diagnose, NOW);
  const CURSOR_FILE_STORE = "export AGENT_CLI_CREDENTIAL_STORE=file\ncursor-agent login\npairfob service install";

  test("an expired login names the provider's own way back in", () => {
    expect(guide("grok", "needs_action", "relogin")).toEqual({ reason: "登录已过期", steps: [t("quota.grokHelp")], command: "grok login" });
    expect(guide("cursor", "needs_action", "relogin")).toEqual({ reason: "登录已过期", steps: [t("quota.cursorHelp")], command: "cursor-agent login" });
    expect(guide("codex", "needs_action", "relogin").command).toBe("codex login");
    // Claude Code renews its login when it runs; Pairfob never names a command that starts it.
    expect(guide("claude", "needs_action", "relogin")).toEqual({ reason: "登录已过期", steps: [t("quota.fix.reloginClaude")], command: null });
    expect(guide("copilot", "needs_action", "relogin").command).toBeNull();
    // The two providers read the login their CLI already holds, so the way
    // back in is that CLI's own login.
    expect(guide("opencode-go", "needs_action", "relogin")).toEqual({ reason: "登录已过期", steps: [t("quota.opencodeGoHelp")], command: "opencode auth login" });
    expect(guide("command-code", "needs_action", "relogin")).toEqual({ reason: "登录已过期", steps: [t("quota.commandCodeHelp")], command: "command-code login" });
  });

  test("a refused Keychain read, several logins and an unset collector each say their own step", () => {
    expect(guide("cursor", "needs_action", "allow_keychain")).toEqual({ reason: "电脑没有允许读取登录信息", steps: [t("quota.cursorKeychainHelp")], command: CURSOR_FILE_STORE });
    expect(guide("claude", "needs_action", "allow_keychain")).toEqual({ reason: "电脑没有允许读取登录信息", steps: [t("quota.fix.keychain")], command: null });
    expect(guide("copilot", "needs_action", "choose_account")).toEqual({ reason: "电脑上有多个登录，还没选用哪个", steps: [t("quota.fix.chooseAccount")], command: null });
    expect(guide("claude", "needs_action", "setup")).toEqual({ reason: "还没有启用采集", steps: [t("quota.setupRequired")], command: "pairfob quota-setup-claude" });
  });

  test("a read that failed with nothing to show offers the computer's own diagnosis, where it has one", () => {
    expect(guide("codex", "failed", "timeout")).toEqual({ reason: "这次读取超时", steps: [t("quota.fix.diagnose")], command: "pairfob quota list" });
    expect(guide("codex", "failed", "unavailable").reason).toBe("这次没有读到");
    // A computer that only answers the first operation has no such command.
    expect(guide("codex", "failed", "unavailable", false)).toEqual({ reason: "这次没有读到", steps: [t("quota.fix.retry")], command: null });
    const throttled = quotaGuidance({ ...quotaOff("codex", "failed", "unavailable"), state: "throttled", reason: "", retry_at: at(600) }, true, NOW);
    expect(throttled).toEqual({ reason: "查询太频繁，10 分钟后可以再刷新", steps: [], command: null });
  });

  test("what is not set up says why, and how to start, without a command to run", () => {
    expect(guide("antigravity", "not_configured", "not_running")).toEqual({ reason: "未运行", steps: [t("quota.antigravityHelp")], command: null });
    expect(guide("codex", "not_configured", "not_installed")).toEqual({ reason: "电脑上没有找到它的命令", steps: [t("quota.codexHelp")], command: null });
    expect(guide("grok", "not_configured", "no_login")).toEqual({ reason: "电脑上没有找到登录", steps: [t("quota.grokHelp")], command: null });
    expect(guide("cursor", "not_configured", "unsupported_login")).toEqual({ reason: "当前登录方式没有订阅余量", steps: [t("quota.cursorUnsupportedHelp")], command: null });
    expect(guide("claude", "not_configured", "unsupported_login").steps).toEqual([]);
    // An older computer's single answer for every login problem keeps Cursor's Keychain way out.
    expect(guide("cursor", "not_configured", "sign_in", false)).toEqual({ reason: t("quota.authRequired"), steps: [t("quota.cursorHelp"), t("quota.cursorKeychainHelp")], command: CURSOR_FILE_STORE });
    expect(guide("grok", "not_configured", "sign_in", false)).toEqual({ reason: t("quota.authRequired"), steps: [t("quota.grokHelp")], command: null });
  });
});

describe("the settings quota module", () => {
  const five = [
    account({ id: "codex", provider: "codex", meters: [share(54)] }),
    account({ id: "claude", provider: "claude", meters: [share(61)] }),
    account({ id: "copilot", provider: "copilot", meters: [share(45)] }),
    account({ id: "cursor", provider: "cursor", meters: [share(94)] }),
    account({ id: "grok", provider: "grok", meters: [share(36)] }),
  ];
  const module = (items: QuotaAccount[], order: QuotaAccount["provider"][] = []) => quotaModuleModel(snapshot(...items), true, order, NOW);

  test("never shows more than four accounts, and one running low takes a place first", () => {
    expect(MODULE_ROWS).toBe(4);
    const model = module(five);
    // Grok would be the fifth; Cursor, which is low, is shown in its own place in the order.
    expect(model.rows.map(row => row.id)).toEqual(["codex", "claude", "copilot", "cursor"]);
    expect(module([...five.slice(0, 3), five[4]!, five[3]!].map((item, index) => index === 3 ? { ...item, meters: [share(95)] } : item)).rows.map(row => row.id))
      .toEqual(["codex", "claude", "cursor", "grok"]);
    expect([model.total, model.attention, model.state]).toEqual([5, 0, "ready"]);
  });

  test("the rows keep the reader's order whatever is left in them", () => {
    const ordered = module(five, ["grok", "cursor"]);
    expect(ordered.rows.map(row => row.id)).toEqual(["grok", "cursor", "codex", "claude"]);
    const drained = module(five.map(item => item.id === "claude" ? { ...item, meters: [share(99)] } : item), ["grok", "cursor"]);
    expect(drained.rows.map(row => row.id)).toEqual(["grok", "cursor", "codex", "claude"]);
  });

  test("a row is the account's summary meter, of any kind, and an account without one is only counted", () => {
    const model = module([
      account({ meters: [share(54, { window_minutes: 10080, resets_at: at(4 * 86400) })] }),
      account({ id: "claude", provider: "claude", meters: [level("low", true)] }),
      account({ id: "cursor", provider: "cursor", meters: [balance(1240, true)] }),
      account({ id: "copilot", provider: "copilot", meters: [share(0, { name: "chat", headline: false }), unlimited()] }),
      quotaOff("grok", "needs_action", "relogin"),
      quotaOff("antigravity", "not_configured", "not_running"),
    ]);
    expect(model.rows.map(row => [row.name, row.sub, row.meter.kind])).toEqual([
      ["Codex", "7 天 · 4 天后重置", "limited"], ["Claude", "模型额度", "level"], ["Cursor", "充值余额", "balance"],
    ]);
    expect([model.total, model.attention]).toEqual([4, 1]);
    // Two accounts of one provider are not two rows with one name.
    const two = module([account(), account({ id: "codex-team", scope: "org", label: "acme" }), account({ id: "codex-cn", region: "cn" })]);
    expect(two.rows.map(row => row.name)).toEqual(["Codex", "Codex · 组织账户 · acme", "Codex · 国内站"]);
    const notices = quotaPanelModel(snapshot({ ...quotaOff("grok", "needs_action", "relogin"), id: "grok-team", label: "team@example.com" }), true, [], NOW);
    expect(notices.attention[0]!.title).toBe("Grok Build · team@example.com");
  });

  test("offline, loading and a failed first read are states, and a failed refresh keeps the rows", () => {
    expect(quotaModuleModel(snapshot(...five), false).state).toBe("offline");
    expect(quotaModuleModel({ loading: true, items: null, error: "" }, true).state).toBe("loading");
    expect(quotaModuleModel({ loading: false, items: null, error: "quota.failed" }, true).state).toBe("error");
    expect(quotaModuleModel(undefined, true).state).toBe("error");
    const kept = quotaModuleModel({ ...snapshot(...five), error: "quota.failed" }, true, [], NOW);
    expect([kept.state, kept.rows.length]).toEqual(["ready", 4]);
    // Numbers kept past fifteen minutes are not shown as current.
    expect(quotaModuleModel(snapshot(...five), true, [], NOW + 900).rows).toEqual([]);
  });
});

describe("the mark that stands beside an account", () => {
  test("every provider this build names has its own mark, never a monogram", () => {
    const missing = QUOTA_PROVIDERS.filter(provider => !agentIcon(provider));
    expect(missing).toEqual([]);
  });
});
