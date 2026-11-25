// Run with ego-browser nodejs and globalThis.PAIRFOB_QA_SPACE set to the
// existing task-space id. Uses production App with local fixture RPCs only.
const task = await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE));
const page = task.page("p1");
const base = globalThis.PAIRFOB_QA_BASE || "http://127.0.0.1:5202";
const fs = await import("node:fs/promises");
const out = "/tmp/pairfob-quota-qa";
await fs.mkdir(out, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];
for (const [surface, width, height, touch] of [
  ["phone", 390, 844, true], ["tablet-middle", 820, 768, true],
  ["tablet", 1024, 768, true], ["desktop", 1440, 900, false],
]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch, screenWidth: width, screenHeight: height });
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await page.cdp("Emulation.setUserAgentOverride", {
    userAgent: touch ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    platform: touch ? "Linux armv8l" : "MacIntel",
  });
  await page.goto(`${base}/qa/index.html?scene=quota&lang=zh`, { timeout: 60000 });
  await page.waitForFunction(() => window.qa?.snapshot().ready, undefined, { timeout: 60000 });
  await page.evaluate(async () => {
    const { liveSession } = await import("/src/features/computers/catalog-store.ts");
    const { setQuotaSnapshot } = await import("/src/features/agent-quota/store.ts");
    const { quotas } = await import("/qa/quota-data.ts");
    const session = liveSession();
    const accounts = quotas().filter(a => a.id === "codex" || a.id === "claude");
    const report = accounts => ({ accounts, legacy: false, unknown: 0 });
    window.quotaQA = { calls: 0, started: 0, first: null, finish: null };
    setQuotaSnapshot(session, { loading: false, items: null, error: "" });
    session.agentQuota = progress => {
      window.quotaQA.calls++;
      window.quotaQA.started = performance.now();
      return new Promise(resolve => {
        setTimeout(() => progress?.(report([accounts[0]])), 100);
        window.quotaQA.finish = () => resolve(report(accounts));
      });
    };
    const observer = new MutationObserver(() => {
      if (window.quotaQA.started && window.quotaQA.first === null && document.querySelector("#quota-codex.quota-card")) {
        window.quotaQA.first = performance.now() - window.quotaQA.started;
        observer.disconnect();
      }
    });
    observer.observe(document.querySelector(".quota-panel"), { childList: true, subtree: true });
  });
  await page.snapshot();
  if (touch) {
    const point = await page.evaluate(() => {
      const r = document.querySelector(".quota-refresh").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.cdp("Input.synthesizeTapGesture", { ...point, duration: 50, tapCount: 1, gestureSourceType: "touch" });
  } else {
    await page.focus(".quota-refresh");
    await page.keyboard.press("Enter");
  }
  await page.waitForSelector("#quota-codex.quota-card");
  const partial = await page.evaluate(() => ({
    first_ms: window.quotaQA.first, calls: window.quotaQA.calls,
    cards: document.querySelectorAll(".quota-card").length,
    disabled: document.querySelector(".quota-refresh").disabled,
    status: document.querySelector('.quota-panel [role="status"]')?.textContent,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    errors: window.qa.snapshot().errors,
  }));
  assert(partial.cards === 1 && partial.disabled && partial.status, `${surface}: incomplete stream not visibly busy`);
  assert(partial.calls === 1 && !partial.errors.length && !partial.overflow, `${surface}: request/layout failure`);
  await page.screenshot({ path: `${out}/${surface}-partial.png` });
  await page.evaluate(() => window.quotaQA.finish());
  await page.waitForFunction(() => document.querySelectorAll(".quota-card").length === 2 && !document.querySelector(".quota-refresh").disabled);
  await page.screenshot({ path: `${out}/${surface}-complete.png` });
  const cardTop = await page.evaluate(() => document.querySelector("#quota-codex").getBoundingClientRect().top);
  // Exercise mouse activation too, and verify cached refresh adds no layout row.
  if (!touch) await page.click(".quota-refresh", { label: "refresh subscriptions" });
  else await page.evaluate(async () => { const { refreshAgentQuota } = await import("/src/features/agent-quota/actions.ts"); void refreshAgentQuota(); });
  const refreshing = await page.evaluate(() => ({ top: document.querySelector("#quota-codex").getBoundingClientRect().top, calls: window.quotaQA.calls }));
  assert(Math.abs(refreshing.top - cardTop) < 1 && refreshing.calls === 2, `${surface}: refresh shifted cached cards`);
  await page.evaluate(() => window.quotaQA.finish());
  await page.waitForFunction(() => !document.querySelector(".quota-refresh").disabled);
  results.push({ surface, width, height, input: touch ? "touch" : "keyboard", partial, passed: true });
}
// Isolate batch waiting versus incremental display with identical 100/1800 ms
// provider fixtures; these are NOT public-network or real-provider timings.
const timing = await page.evaluate(async () => {
  const { liveSession } = await import("/src/features/computers/catalog-store.ts");
  const { setQuotaSnapshot } = await import("/src/features/agent-quota/store.ts");
  const { refreshAgentQuota } = await import("/src/features/agent-quota/actions.ts");
  const { quotas } = await import("/qa/quota-data.ts");
  const session = liveSession();
  const accounts = quotas().filter(a => a.id === "codex" || a.id === "claude");
  const report = { accounts, legacy: false, unknown: 0 };
  const samples = [];
  for (const stream of [false, true]) {
    setQuotaSnapshot(session, { loading: false, items: null, error: "" });
    await new Promise(resolve => requestAnimationFrame(resolve));
    let first = null;
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (first === null && document.querySelector(".quota-card")) first = performance.now() - started;
    });
    observer.observe(document.querySelector(".quota-panel"), { childList: true, subtree: true });
    session.agentQuota = progress => new Promise(resolve => {
      if (stream) setTimeout(() => progress?.({ ...report, accounts: [accounts[0]] }), 100);
      setTimeout(() => resolve(report), 1800);
    });
    await refreshAgentQuota();
    const complete = performance.now() - started;
    await new Promise(resolve => requestAnimationFrame(resolve));
    observer.disconnect();
    samples.push({ stream, first_ms: first, complete_ms: complete });
  }
  const navigation = [];
  accounts.forEach(account => { account.observed_at = Math.floor(Date.now() / 1000); });
  for (const reuse of [false, true]) {
    let reads = 0;
    session.agentQuota = async () => { reads++; await new Promise(resolve => setTimeout(resolve, 120)); return report; };
    const start = performance.now();
    await refreshAgentQuota();
    for (let i = 0; i < 9; i++) await refreshAgentQuota(reuse);
    navigation.push({ reuse, reads, elapsed_ms: performance.now() - start });
  }
  return { simulated_provider_ms: [100, 1800], samples, simulated_rpc_ms: 120, navigation };
});
assert(timing.navigation[0].reads === 10 && timing.navigation[1].reads === 1, "navigation coalescing failed");
const report = { method: "local production App, controlled fixture RPCs", surfaces: results, timing };
await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
