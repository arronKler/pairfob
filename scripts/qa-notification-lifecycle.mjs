// Serve pwa/ on 5199 and set PAIRFOB_QA_SPACE to an owned ego-browser space.
// Real touch/mouse/keyboard drive the app; transport and native delivery are
// fixtures. This does not exercise a physical device or an OS push service.
const page = (await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE))).page("p1");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];
await page.cdp("Network.setBypassServiceWorker", { bypass: true });

for (const [surface, width, height, touch] of [
  ["phone", 390, 844, true], ["tablet", 1024, 768, true],
  ["desktop", 1440, 900, false],
]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: touch, screenWidth: width, screenHeight: height,
  });
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await page.goto("http://127.0.0.1:5199/qa/?scene=home-populated&lang=en");
  await page.waitForFunction(() => window.qa?.snapshot().ready, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const state = window.notificationQA = { requests: [], active: new Map(), hidden: false };
    const port = window.PairfobNotify = {
      onmessage: null,
      postMessage(raw) {
        const request = JSON.parse(raw);
        state.requests.push(request);
        let value = {};
        if (request.method === "status") value = { permission: "granted", backgroundSync: true };
        if (request.method === "requestPermission") value = { permission: "granted" };
        if (request.method === "setBackgroundSync") value = { backgroundSync: request.on };
        if (request.method === "post") { state.active.set(request.tag, request); value = { posted: true }; }
        if (request.method === "cancel") { state.active.delete(request.tag); value = { cancelled: true }; }
        queueMicrotask(() => port.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, value }) }));
      },
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true, get: () => state.hidden ? "hidden" : "visible",
    });
    const { enableLocalNotifications } = await import("/src/features/settings/local-push.ts");
    await enableLocalNotifications();
    const { bindLocalNotifications } = await import("/src/app/local-notifications.ts");
    bindLocalNotifications(new AbortController().signal);
  });

  const row = '.card-main[data-pane-id="w1:p1"]';
  if (touch) {
    const point = await page.evaluate(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, row);
    await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.click(row, { label: "open notification target session" });
    await page.keyboard.press("F6");
  }
  await page.waitForFunction(() => window.qa.snapshot().screen === "pane");
  await page.evaluate(async () => {
    window.notificationQA.hidden = true;
    await window.qa.setAgentStatus("blocked");
  });
  await page.waitForFunction(() => window.notificationQA.active.size === 1);
  await page.evaluate(async () => {
    await window.qa.setAgentStatus("unknown");
    await window.qa.setAgentStatus("blocked");
  });
  assert(await page.evaluate(() => window.notificationQA.active.size === 1
    && window.notificationQA.requests.filter(r => r.method === "post").length === 1
    && !window.notificationQA.requests.some(r => r.method === "cancel")), `${surface}: unknown lost or replayed the wait`);

  await page.evaluate(async () => {
    await window.qa.setAgentStatus("working");
    await window.qa.setAgentStatus("blocked");
  });
  await page.waitForFunction(() => window.notificationQA.requests.filter(r => r.method === "post").length === 2);
  assert(await page.evaluate(() => window.notificationQA.active.size === 1), `${surface}: rapid second wait has no notice`);
  await page.evaluate(async () => { await window.qa.setAgentStatus("working"); });
  await page.waitForFunction(() => window.notificationQA.active.size === 0);
  await page.evaluate(async () => {
    window.notificationQA.hidden = false;
    await window.qa.setAgentStatus("blocked");
  });
  assert(await page.evaluate(() => window.notificationQA.requests.filter(r => r.method === "post").length === 2),
    `${surface}: a visible page posted a system notice`);
  const final = await page.evaluate(() => window.qa.snapshot());
  assert(!final.overflow.documentX && final.errors.length === 0, `${surface}: ${JSON.stringify(final.errors)}`);
  results.push({ surface, input: touch ? "touch" : "mouse and keyboard", passed: true });
}
console.log(JSON.stringify(results, null, 2));
