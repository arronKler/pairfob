import { afterEach, beforeEach, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { attachLiveSession } from "../../features/computers/catalog-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { WorkspaceMediaOpen } from "../../lib/protocol/workspace-media";
import { WorkspaceReadCache } from "../../lib/workspace-cache";
import * as store from "./store";
import * as media from "./media-actions";
import { emptyMediaView } from "./media-model";
import { loadWorkspaceFile, loadGitDiff, showWorkspaceTab, loadDirectory } from "./actions";
const shaEmpty="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const revision="a".repeat(64);
function deferred<T>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function opened(path:string):WorkspaceMediaOpen{return {handle:"media_"+(path.includes("b")?"b":"a").repeat(32),path,kind:"download",mime:"application/octet-stream",size:0,modified_ms:1,sha256:shaEmpty,expires_ms:Date.now()+60000,chunk_bytes:65536,max_bytes:33554432,max_pixels:16777216,width:0,height:0};}
function api(){const opens:string[]=[],closed:string[]=[];return {opens,closed,isConnected:()=>true,
 workspaceMediaOpen:async (_pane:string,path:string)=>{opens.push(path);return opened(path);},
 workspaceMediaRead:async()=>{throw new Error("empty files must not read");},
 workspaceMediaClose:async(handle:string)=>{closed.push(handle);return {handle,closed:true as const};},
 workspaceOpen:async()=>({name:"work",root:"/work",features:{files:true,git_status:false,git_diff:true,git_branches:false},git:null}),
 workspaceList:async()=>({path:"",entries:[],next_cursor:null,truncated:false,revision}),
 workspaceRead:async (_pane:string,path:string)=>({path,kind:"text" as const,size:1,modified_ms:1,content:"text",truncated:false,revision}),
 gitDiff:async(_pane:string,path:string,layer:"worktree"|"staged")=>({path,layer,patch:"@@ -1 +1 @@\n-a\n+b",additions:1,deletions:1,binary:false,truncated:false,revision}),
 gitStatus:async()=>({branch:"main",head:"h",upstream:null,ahead:0,behind:0,truncated:false,revision,changes:[]}),
 gitBranches:async()=>({items:[],truncated:false,revision})};}
async function seed(a=api(),pane="p1"){
 const live=a as unknown as LiveSession;attachLiveSession(live);const {ticket}=store.beginEnter(live,pane,"guided");
 const scope=await new WorkspaceReadCache(a,()=>"/work").open(pane);store.bindScope(ticket,scope);ticket.commit({descriptor:scope.descriptor,view:"file",detailPath:"a.bin"});ticket.finishLoad();return a;
}
let create:typeof URL.createObjectURL,revoke:typeof URL.revokeObjectURL;let serial=0;let revoked:string[]=[];const stops:Array<()=>void>=[];
beforeEach(()=>{create=URL.createObjectURL;revoke=URL.revokeObjectURL;serial=0;revoked=[];URL.createObjectURL=()=>"blob:review/"+(++serial);URL.revokeObjectURL=(url)=>{revoked.push(url);};});
afterEach(()=>{for(const stop of stops.splice(0))stop();store.beginLeave();attachLiveSession(null);URL.createObjectURL=create;URL.revokeObjectURL=revoke;});

import { ProtocolError } from "../../lib/protocol/errors";
import { t } from "../../lib/i18n";

test("current unknown_op retains its actual unsupported-daemon error",async()=>{
 const a=await seed();a.workspaceMediaOpen=async()=>{throw new ProtocolError("unknown_op","WorkspaceMediaOpen");};
 const result=await media.loadWorkspaceMedia("a.bin");const error=store.getWorkspaceSnapshot().media.error;
 console.log("CURRENT_ERROR",JSON.stringify({result,error,expected:t("workspace.media.unsupportedDaemon")}));
 expect(result).toBeFalse();expect(error).toBe(t("workspace.media.unsupportedDaemon"));
});
test("ordinary tab navigation retires its current ready media resource",async()=>{
 await seed();expect(await media.loadWorkspaceMedia("a.bin")).toBeTrue();const url=store.getWorkspaceSnapshot().media.url;
 showWorkspaceTab("changes");
 console.log("TAB_RETIRE",JSON.stringify({view:store.getWorkspaceSnapshot().view,media:store.getWorkspaceSnapshot().media,revoked,privateURL:store.workspaceMediaLoader().currentURL()}));
 expect(store.getWorkspaceSnapshot().view).toBe("browser");expect(revoked).toEqual([url]);expect(store.workspaceMediaLoader().currentURL()).toBe("");
});
for (const stage of ["file", "prepare"] as const) test(`binary image ${stage} publication retirement prevents old autoload under replacement pane`,async()=>{
 const a=api();const requests:Array<{pane:string,path:string}>=[];
 a.workspaceRead=async(_pane,path)=>({path,kind:"binary" as never,size:0,modified_ms:1,content:"",truncated:false,revision});
 a.workspaceMediaOpen=async(pane,path)=>{requests.push({pane,path});return opened(path);};
 await seed(a);let retired=false;
 stops.push(store.subscribeWorkspace(()=>{const s=store.getWorkspaceSnapshot();const at=stage==="file"?s.file?.path==="old.png":s.media.path==="old.png"&&s.media.status==="loading";
  if(!retired&&at){retired=true;const {ticket}=store.beginEnter(a as unknown as LiveSession,"p2","guided");ticket.finishLoad();}
 }));
 await loadWorkspaceFile("old.png");
 console.log("FILE_PREPARE_OWNER",JSON.stringify({stage,retired,requests,pane:store.getWorkspaceSnapshot().paneId,media:store.getWorkspaceSnapshot().media}));
 expect(retired).toBeTrue();expect(store.getWorkspaceSnapshot().paneId).toBe("p2");expect(requests).toEqual([]);
});


test("prepare publication directory navigation retires the original autoload owner", async () => {
  const a = api();
  const requests: Array<{ pane: string; path: string }> = [];
  a.workspaceRead = async (_pane, path) => ({ path, kind: "binary" as never, size: 0, modified_ms: 1, content: "", truncated: false, revision });
  a.workspaceList = async (_pane?: string, path = "") => ({ path, entries: [], next_cursor: null, truncated: false, revision });
  a.workspaceMediaOpen = async (pane, path) => {
    requests.push({ pane, path });
    throw new ProtocolError("unknown_op", "stale autoload must not start");
  };
  await seed(a);
  let moved = false;
  let navigation: Promise<void> | undefined;
  stops.push(store.subscribeWorkspace(() => {
    const snapshot = store.getWorkspaceSnapshot();
    if (!moved && snapshot.media.path === "old.png" && snapshot.media.status === "loading") {
      moved = true;
      navigation = loadDirectory("other");
    }
  }));
  await loadWorkspaceFile("old.png");
  await navigation;
  expect(moved).toBeTrue();
  expect(store.getWorkspaceSnapshot().directory).toBe("other");
  expect(store.getWorkspaceSnapshot().view).toBe("browser");
  expect(requests).toEqual([]);
});
