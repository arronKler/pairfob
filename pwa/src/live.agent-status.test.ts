import { resetBoardTestDOM } from "../test-support/dom";
import { act, createElement } from "react";
import { beforeEach, afterEach, expect, test } from "bun:test";
import type { LiveSession, PairResult, SessionEvent } from "./lib/protocol/client.ts";
import { FullTerminalScreen } from "./ui/react/full-terminal";
import { leaveReactScreen, renderReactScreen } from "./ui/react/root";
import { syncFullTerminalChrome } from "./ui/full-terminal";

beforeEach(resetBoardTestDOM);

const { state, app } = await import("./state.ts");
const { setRenderer } = await import("./paint.ts");
const { closeComputerSession, establish, stopPolling } = await import("./live.ts");


const originalFetch = globalThis.fetch;
const daemonId = "agent_status_events";
afterEach(() => act(() => {
  leaveReactScreen();
  stopPolling();closeComputerSession(daemonId);
  state.live=null;state.credential=null;state.fullTerminal=false;state.agentChat=false;
  globalThis.fetch=originalFetch;app.replaceChildren();
}));

async function boot(fullTerminal: boolean) {
  setRenderer(()=>undefined);
  globalThis.fetch=(async()=>new Response("1.0.0")) as typeof fetch;
  Object.defineProperty(document,"visibilityState",{value:"visible",configurable:true});
  let listener!:(event:SessionEvent)=>void;
  let status="working",reads=0;
  const session={
    close:()=>undefined,isConnected:()=>true,setNetworkAvailable:()=>undefined,
    switchTransport:async()=>undefined,onEvent:(fn:typeof listener)=>{listener=fn;return ()=>{}},
    getConfig:async()=>({build:"1.0.0"}),
    snapshot:async()=>{reads++;return {panes:["p1","p2"].map(pane_id=>({pane_id,workspace_id:"w1",agent:"codex",agent_status:status}))}},
    paneRead:async()=>({text:"unchanged terminal",hash:"a".repeat(64)}),
  } as unknown as LiveSession;
  await establish({daemonId,deviceId:"phone",psk:new Uint8Array(32),daemonPk:new Uint8Array(32),relayOrigin:"https://pairfob.com",fp:"test",createdAt:1} as PairResult,async()=>session);
  stopPolling();
  state.screen="pane";state.paneId="p1";state.fullTerminal=fullTerminal;state.agentChat=false;
  state.paneText="unchanged terminal";state.paneHash="a".repeat(64);state.completionSeen={};
  return {reads:()=>reads,change:(next:string,paneId="p1")=>{status=next;listener({type:"poke",reason:"agent_status",paneId})}};
}
async function settle(){for(let i=0;i<12;i++)await Promise.resolve()}

for(const full of [false,true]) {
  test(`status events reach the production snapshot path without fallback timers (full=${full})`,async()=>{
    const runtime=await boot(full);
    const before=runtime.reads();
    runtime.change("done");await settle();
    expect(runtime.reads()).toBe(before+1);
    expect(state.runtimeAgentStatuses.p1).toBe("done");
    runtime.change("working");await settle();
    expect(state.runtimeAgentStatuses.p1).toBe("working");
    expect(state.agents.find(a=>a.paneId==="p1")?.status).toBe("working");
  });
}

test("another pane's status updates the sidebar while a terminal is open",async()=>{
  const runtime=await boot(true);const before=runtime.reads();
  runtime.change("done","p2");await settle();
  expect(runtime.reads()).toBe(before+1);
  expect(state.agents.find(a=>a.paneId==="p2")?.status).toBe("done");
});

test("hidden status events do not start network reads",async()=>{
  const runtime=await boot(true);const before=runtime.reads();
  Object.defineProperty(document,"visibilityState",{value:"hidden",configurable:true});
  runtime.change("done");await settle();expect(runtime.reads()).toBe(before);
});


test("mobile full-terminal controls follow status without remounting the terminal",async()=>{
  const runtime=await boot(true);state.runtimeKind="herdr";state.networkOnline=true;
  const noop = () => {};
  act(() => {
    syncFullTerminalChrome();
    renderReactScreen(createElement(FullTerminalScreen, {
      onBack: noop, onWorkspace: noop, onMenu: noop, onStop: noop, onRetry: noop,
      scroll: noop, pageLines: () => 23, engineActive: false,
      controls: { sendKey: noop, sendCompose: () => true, desk: false,
        keyboard: { toggle: noop, open: noop, close: noop, isOpen: () => false } },
    }));
  });
  const host=app.querySelector(".full-terminal-host");
  expect(host === null).toBeFalse();
  expect(app.querySelector("[data-react-full-terminal]") === null).toBeFalse();
  await act(async () => { runtime.change("working"); await settle(); });
  expect(app.querySelector(".icon-stop") === null).toBeFalse();
  await act(async () => { runtime.change("done"); await settle(); });
  expect(app.querySelector(".icon-stop") === null).toBeTrue();
  expect(app.querySelector(".full-terminal-host")).toBe(host);
});
