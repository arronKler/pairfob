// Run through ego-browser nodejs after setting PAIRFOB_QA_SPACE and optionally
// PAIRFOB_QA_BASE (default candidate :5200). Local QA only; no public transport.
const task = await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE));
const page = task.page("p1");
const base = globalThis.PAIRFOB_QA_BASE || "http://127.0.0.1:5200";
const variant = globalThis.PAIRFOB_QA_VARIANT || "candidate";
const fs = await import("node:fs/promises");
const out = "/tmp/pairfob-load-qa";
await fs.mkdir(out, { recursive: true });
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function activate(selector, touch) {
  if (!touch) { await page.click(selector, { label: "open workspace content" }); return; }
  const point = await page.evaluate(selector => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await page.cdp("Input.synthesizeTapGesture", { ...point, duration:50, tapCount:1, gestureSourceType:"touch" });
}
const results = [];
for (const [surface, width, height, touch] of [
  ["phone",390,844,true], ["tablet-middle",820,768,true],
  ["tablet",1024,768,true], ["desktop",1440,900,false],
]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:touch,screenWidth:width,screenHeight:height });
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled:touch,maxTouchPoints:touch?5:1 });
  await page.cdp("Emulation.setUserAgentOverride", {userAgent:touch ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform:touch ? "Linux armv8l":"MacIntel"});
  await page.goto(`${base}/qa/index.html?scene=workspace-changes&lang=zh`, { timeout:60000 });
  await page.waitForFunction(() => window.qa?.snapshot().ready, undefined, { timeout:30000 });
  const before = await page.evaluate(() => ({ calls:window.qa.calls.map(c=>c.method),errors:window.qa.snapshot().errors, viewport:[innerWidth,innerHeight] }));
  assert(before.viewport[0]===width && before.viewport[1]===height, `${surface}: viewport mismatch ${before.viewport}`);
  assert(!before.errors.length, `${surface}: scene errors`);
  assert(before.calls.includes("gitStatus"), `${surface}: shared Git metadata lost`);
  assert(before.calls.filter(x=>x==="workspaceList").length === (variant==="baseline"?1:0), `${surface}: directory demand`);
  if (variant === "baseline") { results.push({surface,width,height,before,measurementOnly:true}); continue; }
  await page.snapshot(); // Ground the tab selectors in the rendered page.
  const files = '[role="tab"]:nth-child(2)';
  if (touch) await activate(files,true);
  else { await page.focus(files); await page.keyboard.press("Enter"); }
  await page.waitForSelector(".workspace-file .workspace-row-main");
  const counts = await page.evaluate(() => ({ calls:window.qa.calls.map(c=>c.method), rows:document.querySelectorAll(".workspace-file .workspace-row-main").length }));
  assert(counts.rows>0, `${surface}: files never appeared`);
  assert(counts.calls.filter(x=>x==="workspaceList").length===1, `${surface}: redundant first directory read`);
  // Select a visible ordinary file from the inspected list, then use real input.
  const fileSelector = await page.evaluate(() => {
    const rows=[...document.querySelectorAll(".workspace-file .workspace-row-main")];
    const row=rows.find(el=>el.textContent.includes("README.md"));
    if(!row) throw new Error("README row missing");
    row.setAttribute("data-qa-load-file","true");
    return '[data-qa-load-file="true"]';
  });
  await activate(fileSelector,touch);
  await page.waitForFunction(() => window.qa.calls.some(c=>c.method==="workspaceRead"));
  await page.waitForSelector(".workspace-code-line");
  await page.screenshot({ path:`${out}/${variant}-${surface}.png` });
  const after = await page.evaluate(() => ({calls:window.qa.calls.map(c=>c.method),errors:window.qa.snapshot().errors,overflow:window.qa.snapshot().overflow}));
  assert(!after.errors.length, `${surface}: navigation errors`);
  await page.evaluate(async () => { await window.qa.setScene("board-busy"); });
  await page.waitForSelector(".board-pane-screen");
  const previews = await page.evaluate(() => [...document.querySelectorAll(".board-pane-screen")].map(e=>e.textContent));
  assert(previews.length===3 && previews.every(text=>text.trim()), `${surface}: board preview missing`);
  await page.screenshot({ path:`${out}/${variant}-${surface}-board.png` });
  await activate('.board-pane[data-pane-id="b1:p1"] .board-pane-open',touch);
  await page.waitForFunction(() => window.qa.snapshot().screen === "pane");
  results.push({surface,width,height,input:touch?"touch":"keyboard + mouse",before,after,board_previews:previews.length,board_opened:true,passed:true});
}
const hint = await page.evaluate(async variant => {
  await window.qa.setScene("board-busy");
  const paneId=document.querySelector(".board-pane[data-pane-id]")?.getAttribute("data-pane-id");
  if(!paneId) throw new Error("Board pane missing");
  window.qa.clearCalls();
  const refresh=await import("/src/features/board/preview/refresh.ts");
  if(variant==="baseline") await refresh.refreshBoardPreviews();
  else await refresh.refreshBoardPreviewHint(paneId);
  return {paneId,reads:window.qa.calls.filter(c=>c.method==="paneRead").length,errors:window.qa.snapshot().errors};
}, variant);
// Controlled 100 ms read latency isolates serial versus bounded concurrency.
// These are fixture timings, NOT measurements of the public network.
const board = await page.evaluate(async () => {
  const {runPreviewPass,clearBoardPreviews} = await import("/src/features/board/preview/store.ts");
  const samples=[];
  for(let round=0;round<3;round++) {
    clearBoardPreviews(); let active=0,peak=0,reads=0;
    const started=performance.now();
    await runPreviewPass({ids:Array.from({length:8},(_,i)=>`bench:${i}`),linesOf:()=>24,alive:()=>true,
      source:{paneRead:async id=>{reads++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,100));active--;return{text:id,hash:id};}}});
    samples.push({ms:performance.now()-started,reads,peak,configured_read_delay_ms:100});
  }
  return samples;
});
const report={variant,method:"local production QA with fixture RPCs; board latency explicitly simulated",surfaces:results,board,hint};
await fs.writeFile(`${out}/${variant}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
