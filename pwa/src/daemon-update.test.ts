import { expect, test, beforeEach, afterEach } from "bun:test";
import { happy, resetBoardTestDOM } from "../test-support/dom";
import { act, createElement, Fragment } from "react";
import { leaveReactScreen, renderReactScreen } from "./ui/react/root";
import { ProtocolError } from "./lib/protocol/errors";
import type { LiveSession } from "./lib/protocol/session-types";
const { state, app } = await import("./state");
const { setRenderer } = await import("./paint");
const { acceptDaemonVersion, daemonVersion, refreshDaemonUpdate, startDaemonUpdate, checkDaemonRelease } = await import("./daemon-update");
const { DaemonUpdate, ManualUpdateHelp } = await import("./ui/react/daemon-update");
function paintDaemon(detailed = false): void {
  act(() => renderReactScreen(createElement(DaemonUpdate, { compact: !detailed })));
}
function paintManualHelp(): void {
  act(() => renderReactScreen(createElement(ManualUpdateHelp)));
}
const { setLang } = await import("./lib/i18n");
beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  setRenderer(() => {});
  state.credential = null;
  state.notice = null;
  setLang("zh");
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
});
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
function visibility(value: string) {
  Object.defineProperty(happy.document,"visibilityState",{value, configurable:true});
  happy.document.dispatchEvent(new happy.Event("visibilitychange"));
}
afterEach(async () => {
  act(() => { visibility("hidden"); leaveReactScreen(); });
  Date.now = originalNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.fetch = originalFetch;
  state.live = null;
  state.credential = null;
  setRenderer(() => {});
  setLang("zh");
  await act(async () => { await Promise.resolve(); });
});
let serial=0;
function connect(rpc: Partial<LiveSession>, build="1.0.0") {
  state.credential = {daemonId:`update-test-${++serial}`} as typeof state.credential;
  state.screen="settings";
  state.live={isConnected:()=>true,...rpc} as LiveSession;
  globalThis.fetch=(async()=>new Response("1.1.0")) as typeof fetch;
  act(() => acceptDaemonVersion({build}));
}
const idle = {available:true,phase:"idle",target:"",operation_id:""};
test("legacy daemon offers a command, never an unsupported remote update", async()=>{
  connect({daemonUpdateStatus:async()=>{throw new ProtocolError("unknown_op")}},"0.1.0");
  await act(async () => { await checkDaemonRelease(); });await act(async () => { await refreshDaemonUpdate(); });paintDaemon(true);
  expect(app.textContent).toContain("pairfob update");
  expect(app.querySelector(".daemon-update-version")?.textContent).toContain("无法确认实际版本");
  expect(app.querySelector(".daemon-update-version")?.textContent).not.toContain("0.1.0");
  expect([...app.querySelectorAll("button")].some(e=>e.textContent==="更新电脑端")).toBeFalse();
});
test("concurrent clicks and unknown outcome do not replay the mutation",async()=>{
 let writes=0;let reject!:(e:Error)=>void;
 connect({daemonUpdateStatus:async()=>idle,daemonUpdate:async()=>{writes++;return new Promise((_,r)=>{reject=r})}});
 await act(async () => { await refreshDaemonUpdate(); });
 const first=startDaemonUpdate();await Promise.resolve();await act(async () => { await startDaemonUpdate(); });
 expect(writes).toBe(1);reject(new ProtocolError("unknown_outcome"));await first;
 await act(async () => { await refreshDaemonUpdate(); });await act(async () => { await startDaemonUpdate(); });expect(writes).toBe(1);expect(daemonVersion()?.uncertain).toBeTrue();
});
test("completion requires the target to be running",async()=>{
 connect({daemonUpdateStatus:async()=>({...idle,phase:"complete",target:"1.1.0",operation_id:"op_abcdefghijklmnop"}),getConfig:async()=>({build:"1.0.0"})});
 await act(async () => { await refreshDaemonUpdate(); });paintDaemon(true);expect(app.textContent).toContain("等待确认运行版本");expect(app.textContent).not.toContain("更新完成");
});
test("previous computer status cannot overwrite the current view",async()=>{
 let resolve!:(x:unknown)=>void;
 connect({daemonUpdateStatus:()=>new Promise(r=>{resolve=r})});
 connect({daemonUpdateStatus:async()=>idle},"2.0.0");await act(async () => { await refreshDaemonUpdate(); });
 resolve({...idle,phase:"failed"});await Promise.resolve();await Promise.resolve();
 expect(daemonVersion()?.build).toBe("2.0.0");expect(daemonVersion()?.status?.phase).toBe("idle");
});

test("config refresh during a mutation preserves its owner and clears pending state",async()=>{
 for(const fails of [false,true]) {
  let finish!:(x:unknown)=>void, reject!:(e:Error)=>void;
  connect({daemonUpdateStatus:async()=>idle,daemonUpdate:()=>new Promise((r,j)=>{finish=r;reject=j})});
  await act(async () => { await refreshDaemonUpdate(); });const pending=startDaemonUpdate();await Promise.resolve();
  const owner=daemonVersion();expect(owner?.requesting).toBeTrue();
  act(() => acceptDaemonVersion({build:"1.0.0"}));expect(daemonVersion()).toBe(owner);
  if(fails)reject(new ProtocolError("unknown_outcome"));else finish({...idle,phase:"downloading",target:"1.1.0",operation_id:"op_abcdefghijklmnop"});
  await pending;expect(daemonVersion()?.requesting).toBeFalse();
  if(fails)expect(daemonVersion()?.uncertain).toBeTrue();
 }
});


test("manual check bypasses release cache and updates a mounted sidebar without repainting the pane", async () => {
  connect({daemonUpdateStatus:async()=>idle});
  await act(async () => { await checkDaemonRelease(true); });
  state.screen="pane";
  act(() => renderReactScreen(createElement(Fragment, null,
    createElement("textarea", { defaultValue: "unfinished draft" }),
    createElement(DaemonUpdate, { compact: true }),
  )));
  const input = app.querySelector("textarea")!;
  globalThis.fetch=(async()=>new Response("1.2.0")) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  expect(app.textContent).toContain("1.2.0");
  expect(app.querySelector("textarea") === input).toBe(true);
  expect(input.value).toBe("unfinished draft");
  paintDaemon(true);
  let reads=0;
  globalThis.fetch=(async()=>{reads++;return new Response("1.3.0")}) as typeof fetch;
  const check=[...app.querySelectorAll("button")].find(b=>b.textContent==="检查更新")!;
  act(() => check.click());await act(async () => { await checkDaemonRelease(); });
  expect(reads).toBe(1);expect(daemonVersion()?.latest).toBe("1.3.0");
});

test("failed release checks retry after one minute instead of waiting six hours", async () => {
  connect({daemonUpdateStatus:async()=>idle});await act(async () => { await checkDaemonRelease(true); });
  let now=originalNow();Date.now=()=>now;
  globalThis.fetch=(async()=>{throw new Error("offline")}) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });expect(daemonVersion()?.error).toBeTrue();
  let reads=0;globalThis.fetch=(async()=>{reads++;return new Response("1.1.0")}) as typeof fetch;
  await act(async () => { await checkDaemonRelease(); });expect(reads).toBe(0);
  now+=60001;await act(async () => { await checkDaemonRelease(); });expect(reads).toBe(1);expect(daemonVersion()?.error).toBeFalse();
});

test("visible pages check periodically and foreground resumes status reads without reconnecting", async () => {
  let statuses=0;
  connect({daemonUpdateStatus:async()=>{statuses++;return {...idle,phase:"downloading",target:"1.1.0",operation_id:"op_abcdefghijklmnop"}}});
  await act(async () => { await refreshDaemonUpdate(); });await act(async () => { await checkDaemonRelease(true); });
  const timers=new Map<number,{fn:()=>void,ms:number}>();let id=0;
  globalThis.setTimeout=((fn:()=>void,ms:number)=>{timers.set(++id,{fn,ms});return id}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=((id:number)=>{timers.delete(id)}) as unknown as typeof clearTimeout;
  let now=originalNow();Date.now=()=>now;
  const before=statuses;visibility("visible");await act(async () => { await refreshDaemonUpdate(); });
  expect(statuses).toBeGreaterThan(before);
  expect([...timers.values()].some(t=>t.ms===3000)).toBeTrue();
  const periodic=[...timers.values()].find(t=>t.ms>60000)!;expect(periodic).toBeDefined();
  let reads=0;globalThis.fetch=(async()=>{reads++;return new Response("1.2.0")}) as typeof fetch;
  now+=6*60*60*1000+1;periodic.fn();await act(async () => { await checkDaemonRelease(); });expect(reads).toBe(1);
  visibility("hidden");
  const paused=statuses;happy.window.dispatchEvent(new happy.Event("focus"));
  await Promise.resolve();expect(statuses).toBe(paused);
});

test("real config ingestion preserves old-daemon guidance while capabilities fail closed", async () => {
  const {refreshHerdConfig}=await import("./live");
  for(const config of [null, [], {build:"0.1.0"},{build:"1.0.0",protocol:1}]) {
    connect({getConfig:async()=>config as Record<string, unknown>,daemonUpdateStatus:async()=>idle});
    await act(async () => { await refreshHerdConfig(); });await act(async () => { await refreshDaemonUpdate(); });
    expect(daemonVersion()?.incompatible).toBeTrue();
    expect(Object.values(state.operationCapabilities).every(v=>v===false)).toBeTrue();
    paintDaemon(true);
    expect(app.textContent).toContain("pairfob update");
    expect([...app.querySelectorAll("button")].some(b=>b.textContent==="更新电脑端")).toBeFalse();
  }
});

test("offline settings and computer help offer manual upgrade without claiming a new version", () => {
  state.credential={daemonId:"never-connected"} as typeof state.credential;state.live=null;
  paintDaemon(true);
  expect(app.textContent).toContain("pairfob update");expect(app.textContent).not.toContain("电脑端有更新");
  paintManualHelp();
  expect(app.textContent).toContain("网络或电脑离线");
});


test("entering settings reads a very old config independently of push capability validation", async () => {
  const {refreshSettings}=await import("./live-settings");
  connect({listDevices:async()=>({devices:[]}),getConfig:async()=>({build:"0.1.0"}),daemonUpdateStatus:async()=>{throw new ProtocolError("unknown_op")}});
  await act(async () => { await refreshSettings(); });
  expect(daemonVersion()?.build).toBe("0.1.0");
  expect(daemonVersion()?.incompatible).toBeTrue();
  expect((state.pushEnabled) === null).toBe(true);
  paintDaemon(true);expect(app.textContent).toContain("pairfob update");
});

test("release check has a visible busy state and explicit success or failure feedback", async () => {
  connect({daemonUpdateStatus:async()=>idle},"1.1.0");
  await act(async () => { await checkDaemonRelease(true); });paintDaemon(true);
  let finish!:(r:Response)=>void;
  globalThis.fetch=(()=>new Promise(r=>{finish=r})) as typeof fetch;
  act(() => app.querySelector<HTMLButtonElement>(".daemon-update-check")!.click());
  const pending=checkDaemonRelease();
  const busy=app.querySelector<HTMLButtonElement>(".daemon-update-check")!;
  expect(busy.disabled).toBeTrue();expect(busy.textContent).toContain("正在检查");
  expect(busy.classList.contains("btn-ghost")).toBeFalse();
  expect(app.querySelector('[role="status"]')?.textContent).toContain("正在查询");
  await act(async () => { finish(new Response("1.1.0")); await pending; });
  expect(app.querySelector<HTMLButtonElement>(".daemon-update-check")?.disabled).toBeFalse();
  expect(app.querySelector('[data-tone="ok"]')?.textContent).toContain("已是最新版本");
  globalThis.fetch=(async()=>{throw new Error("offline")}) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  expect(app.querySelector('[data-tone="error"]')?.textContent).toContain("检查失败");
  expect((app.querySelector('[data-tone="ok"]')) === null).toBe(true);
  paintDaemon(true);
  expect(app.querySelector('[data-tone="error"]')?.textContent).toContain("检查失败");
});


test("update copy follows the selected language", async () => {
  connect({daemonUpdateStatus:async()=>idle},"1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  setLang("en");
  paintDaemon(true);
  expect(app.querySelector(".daemon-update-check")?.textContent).toBe("Check for updates");
  expect(app.textContent).toContain("Computer version");
});

test("routine settings version stays compact even when background checks fail", async () => {
  connect({daemonUpdateStatus:async()=>idle},"ad27e83");
  globalThis.fetch=(async()=>{throw new Error("offline")}) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });paintDaemon(true);
  expect(app.querySelector(".daemon-update-version-row")?.textContent).toContain("ad27e83");
  expect(app.querySelector(".daemon-update-check")?.textContent).toBe("检查更新");
  expect((app.querySelector(".daemon-update-feedback")) === null).toBe(true);
  expect((app.querySelector(".set-card")) === null).toBe(true);
});
