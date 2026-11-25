// Run with ego-browser nodejs in the current task space, using local fixtures.
const task = await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE));
const page = task.page("p1");
const base = globalThis.PAIRFOB_QA_BASE || "http://127.0.0.1:5202";
const fs = await import("node:fs/promises");
const out = "/tmp/pairfob-quota-followup-qa";
await fs.mkdir(out, { recursive: true });
const assert = (ok, message) => { if (!ok) throw new Error(message); };
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
  await page.goto(`${base}/qa/index.html?scene=settings&lang=zh`, { timeout: 60000 });
  await page.waitForFunction(() => window.qa?.snapshot().ready, undefined, { timeout: 60000 });
  await page.evaluate(async () => {
    const { liveSession } = await import("/src/features/computers/catalog-store.ts");
    const { setQuotaSnapshot } = await import("/src/features/agent-quota/store.ts");
    const { refreshAgentQuota } = await import("/src/features/agent-quota/actions.ts");
    const { quotas } = await import("/qa/quota-data.ts");
    const session = liveSession();
    const codex = quotas().find(a => a.id === "codex");
    codex.observed_at = Math.floor(Date.now() / 1000);
    const attention = { ...codex, id: "claude", provider: "claude", state: "needs_action", reason: "relogin", observed_at: 0, meters: [] };
    const report = accounts => ({ accounts, legacy: false, unknown: 0 });
    window.settingsQuotaQA = { calls: 0 };
    session.agentQuota = progress => {
      window.settingsQuotaQA.calls++;
      return new Promise((resolve, reject) => {
        window.settingsQuotaQA.fail = () => reject(new Error("fixture disconnect"));
        window.settingsQuotaQA.attention = () => progress?.(report([attention]));
        window.settingsQuotaQA.numbers = () => progress?.(report([attention, codex]));
        window.settingsQuotaQA.finish = () => resolve(report([codex, attention]));
      });
    };
    setQuotaSnapshot(session, { loading: false, items: null, error: "" });
    void refreshAgentQuota();
    window.settingsQuotaQA.attention();
  });
  await page.waitForFunction(() => document.querySelector(".quota-module")?.textContent.includes("其余订阅读取中"));
  const early = await page.evaluate(() => document.querySelector(".quota-module").textContent);
  assert(early.includes("1 个需要处理") && !early.includes("刚刚更新"), `${surface}: early attention hidden or looks complete`);
  await page.snapshot();
  const activate = async selector => {
    if (touch) {
      const point = await page.evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; }, selector);
      await page.cdp("Input.synthesizeTapGesture", { ...point, duration: 50, tapCount: 1, gestureSourceType: "touch" });
    } else await page.click(selector, { label: "open quota details" });
  };
  await activate(".quota-all");
  await page.waitForSelector(".quota-panel");
  const detail = await page.evaluate(() => ({ text:document.querySelector(".quota-panel").textContent, busy:document.querySelector(".quota-panel").getAttribute("aria-busy"), disabled:document.querySelector(".quota-refresh").disabled, calls:window.settingsQuotaQA.calls }));
  assert(detail.calls===1 && detail.busy === "true" && detail.disabled && detail.text.includes("Claude"), `${surface}: partial navigation lost error or duplicated read`);
  await page.screenshot({path:`${out}/${surface}-attention.png`});
  await page.snapshot();
  await activate('button[aria-label="返回"]');
  await page.waitForSelector(".quota-module");
  await page.evaluate(() => window.settingsQuotaQA.numbers());
  await page.waitForFunction(() => document.querySelector(".quota-module")?.textContent.includes("已读取 1 个"));
  await page.screenshot({path:`${out}/${surface}-partial.png`});
  const partial = await page.evaluate(() => ({ text:document.querySelector(".quota-module").textContent, calls:window.settingsQuotaQA.calls, overflow:document.documentElement.scrollWidth>innerWidth+1, errors:window.qa.snapshot().errors }));
  assert(partial.calls===1 && !partial.overflow && !partial.errors.length && partial.text.includes("其余订阅读取中"), `${surface}: partial summary failure`);
  await page.evaluate(() => window.settingsQuotaQA.finish());
  await page.waitForFunction(() => !document.querySelector(".quota-module")?.textContent.includes("其余订阅读取中"));
  const complete = await page.evaluate(() => document.querySelector(".quota-module").textContent);
  assert(complete.includes("共 1 个") && complete.includes("1 个需要处理"), `${surface}: incorrect final summary`);
  await page.screenshot({path:`${out}/${surface}-complete.png`});
  await page.evaluate(async () => {
    const { refreshAgentQuota } = await import("/src/features/agent-quota/actions.ts");
    void refreshAgentQuota();
    window.settingsQuotaQA.numbers();
    window.settingsQuotaQA.fail();
  });
  await page.waitForFunction(() => document.querySelector(".quota-module")?.textContent.includes("余量读取失败"));
  const failed = await page.evaluate(() => document.querySelector(".quota-module").textContent);
  assert(failed.includes("已读取 1 个") && !failed.includes("刚刚更新") && !failed.includes("其余订阅读取中"), `${surface}: failed partial read looks complete`);
  await page.screenshot({path:`${out}/${surface}-failed.png`});
  results.push({surface,width,height,input:touch?"touch":"mouse",early,partial,complete,failed,passed:true});
}
await fs.writeFile(`${out}/results.json`,JSON.stringify({method:"production App with controlled partial quota fixtures",surfaces:results},null,2));
console.log(JSON.stringify(results));
