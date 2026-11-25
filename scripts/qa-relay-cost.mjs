// Serve the PWA fixtures on 5199. Set PAIRFOB_QA_SPACE to an owned ego-browser
// space before importing; input is real touch/mouse/keyboard, transport is local.
const page = (await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE))).page("p1");
const fs = await import("node:fs/promises");
const artifacts = "/tmp/pairfob-relay-cost-qa";
await fs.mkdir(artifacts, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];

for (const surface of [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet-compact", width: 820, height: 900, touch: true },
  { name: "tablet", width: 1024, height: 768, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false },
]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: surface.width, height: surface.height, deviceScaleFactor: 1,
    mobile: surface.touch, screenWidth: surface.width, screenHeight: surface.height,
  });
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: surface.touch, maxTouchPoints: surface.touch ? 5 : 1 });
  await page.goto("http://127.0.0.1:5199/qa/index.html?scene=guided&lang=zh", { timeout: 60_000 });
  await page.waitForFunction(() => window.qa?.snapshot().ready, undefined, { timeout: 60_000 });
  const initial = await page.evaluate(() => ({
    width: innerWidth, coarse: matchMedia("(any-pointer: coarse)").matches,
    focused: document.activeElement?.tagName,
  }));
  assert(initial.width === surface.width && initial.coarse === surface.touch, `${surface.name}: wrong surface`);
  if (surface.touch) assert(initial.focused !== "TEXTAREA", `${surface.name}: automatic keyboard focus`);
  await page.evaluate(async () => {
    window.qa.clearCalls();
    window.qa.hold("paneRead");
    document.querySelector('textarea[name="pairfob-compose"]').dataset.costQaOwner = "original";
    const controller = await import("/src/features/connection/controller.ts");
    controller.startPolling();
  });
  await page.waitForFunction(() => window.qa.calls.filter(x => x.method === "paneRead").length === 1);

  const selector = 'textarea[name="pairfob-compose"]';
  if (surface.touch) {
    const at = await page.evaluate(() => {
      const box = document.querySelector('textarea[name="pairfob-compose"]').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...at, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
    await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else await page.click(selector, { label: "type through pending refresh" });
  await page.keyboard.type("cost check draft");

  await page.evaluate(async () => {
    const controller = await import("/src/features/connection/controller.ts");
    controller.wakeLiveReads();
    void controller.refreshPaneRead();
    window.qa.release("paneRead");
  });
  await page.waitForFunction(() => window.qa.calls.filter(x => x.method === "paneRead").length === 2);
  await page.evaluate(() => { window.costQaLastRead = performance.now(); });
  // Real elapsed time exercises the timer boundary; no fake clock or timer replacement.
  await page.waitForFunction(() => performance.now() - window.costQaLastRead >= 1_100);
  await page.evaluate(async () => {
    const controller = await import("/src/features/connection/controller.ts");
    await controller.refreshPaneRead();
    window.costQaExplicitRead = performance.now();
  });
  await page.waitForFunction(() => performance.now() - window.costQaExplicitRead >= 500);
  const after = await page.evaluate(() => ({
    reads: window.qa.calls.filter(x => x.method === "paneRead").length,
    owner: document.querySelector('textarea[name="pairfob-compose"]').dataset.costQaOwner,
    draft: document.querySelector('textarea[name="pairfob-compose"]').value,
    focused: document.activeElement === document.querySelector('textarea[name="pairfob-compose"]'),
  }));
  assert(after.reads === 3, `${surface.name}: redundant fallback after explicit read: ${after.reads}`);
  assert(after.owner === "original" && after.draft === "cost check draft" && after.focused,
    `${surface.name}: refresh replaced input, focus or draft`);
  await page.waitForFunction(() => window.qa.calls.filter(x => x.method === "paneRead").length >= 4);
  await page.evaluate(async () => { (await import("/src/features/connection/controller.ts")).stopPolling(); });
  const snapshot = await page.evaluate(() => window.qa.snapshot());
  assert(snapshot.errors.length === 0, `${surface.name}: runtime errors ${JSON.stringify(snapshot.errors)}`);
  assert(snapshot.overflow.documentX === 0, `${surface.name}: horizontal overflow`);
  assert(!snapshot.calls.some(x => x.kind === "mutation"), `${surface.name}: typing sent an unintended mutation`);
  await page.screenshot({ path: `${artifacts}/${surface.name}.png` });
  results.push({ surface, initial, after, errors: snapshot.errors, overflow: snapshot.overflow });
  console.log({ surface: surface.name, passed: true, after });
}
await fs.writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
