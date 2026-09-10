import { afterEach, beforeEach, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { attachLiveSession } from "../../features/computers/catalog-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { WorkspaceMediaOpen } from "../../lib/protocol/workspace-media";
import { WorkspaceReadCache } from "../../lib/workspace-cache";
import * as store from "./store";
import * as media from "./media-actions";
import { emptyMediaView } from "./media-model";
import { loadGitDiff, showWorkspaceTab } from "./actions";
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

test("positive normal load owns only plain frozen media view and revokes on retirement",async()=>{
 const a=await seed();media.prepareWorkspaceMedia("a.bin",0);expect(await media.loadWorkspaceMedia("a.bin")).toBeTrue();
 const snap=store.getWorkspaceSnapshot();expect(snap.media.status).toBe("ready");expect(Object.isFrozen(snap.media)).toBeTrue();expect(Object.values(snap.media).every(x=>typeof x==="string"||typeof x==="number")).toBeTrue();
 const url=snap.media.url;store.beginLeave();expect(revoked).toEqual([url]);expect(a.closed).toEqual([opened("a.bin").handle]);
});
test("loading publication retirement prevents any old Open RPC",async()=>{
 const a=await seed();let retired=false;stops.push(store.subscribeWorkspace(()=>{if(!retired&&store.getWorkspaceSnapshot().media.status==="loading"){retired=true;store.beginLeave();}}));
 const result=await media.loadWorkspaceMedia("a.bin");console.log("RETIRED_INITIAL",JSON.stringify({retired,result,opens:a.opens}));expect(retired).toBeTrue();expect(a.opens).toEqual([]);expect(result).toBeFalse();
});
test("a load begun by loading subscriber beats the older continuation",async()=>{
 const a=await seed();let once=false;let newer:Promise<boolean>|undefined;stops.push(store.subscribeWorkspace(()=>{const m=store.getWorkspaceSnapshot().media;if(!once&&m.path==="a.bin"&&m.status==="loading"){once=true;newer=media.loadWorkspaceMedia("b.bin");}}));
 const older=await media.loadWorkspaceMedia("a.bin");const latest=await newer;console.log("REENTRANT_LOAD",JSON.stringify({older,latest,opens:a.opens,media:store.getWorkspaceSnapshot().media}));expect(older).toBeFalse();expect(latest).toBeTrue();expect(store.getWorkspaceSnapshot().media.path).toBe("b.bin");
});
test("tab publication cannot clear a replacement media load started by its subscriber",async()=>{
 await seed();media.prepareWorkspaceMedia("a.bin",0);await media.loadWorkspaceMedia("a.bin");let once=false;let newer:Promise<boolean>|undefined;
 stops.push(store.subscribeWorkspace(()=>{if(!once&&store.getWorkspaceSnapshot().tab==="changes"){once=true;media.prepareWorkspaceMedia("b.bin",0);newer=media.loadWorkspaceMedia("b.bin");}}));
 showWorkspaceTab("changes");const latest=await newer;console.log("TAB_REENTRY",JSON.stringify({latest,media:store.getWorkspaceSnapshot().media}));expect(latest).toBeTrue();expect(store.getWorkspaceSnapshot().media.path).toBe("b.bin");
});
test("actual diff navigation retires a held media operation",async()=>{
 const a=await seed();const gate=deferred<WorkspaceMediaOpen>();const entered=deferred<void>();a.workspaceMediaOpen=async(_pane,path)=>{a.opens.push(path);entered.resolve();return gate.promise;};
 const old=media.loadWorkspaceMedia("a.bin");await entered.promise;await loadGitDiff("other.ts","worktree");gate.resolve(opened("a.bin"));const result=await old;
 console.log("DIFF_OWNER",JSON.stringify({result,view:store.getWorkspaceSnapshot().view,media:store.getWorkspaceSnapshot().media}));expect(result).toBeFalse();expect(store.getWorkspaceSnapshot().view).toBe("diff");expect(store.getWorkspaceSnapshot().media.url).toBe("");
});
test("positive root retirement closes late old Open without revoking replacement URL",async()=>{
 const a=await seed();const gate=deferred<WorkspaceMediaOpen>();const entered=deferred<void>();a.workspaceMediaOpen=async(_pane,path)=>{a.opens.push(path);entered.resolve();return gate.promise;};
 const old=media.loadWorkspaceMedia("a.bin");await entered.promise;const b=await seed(api(),"p2");expect(await media.loadWorkspaceMedia("b.bin")).toBeTrue();const url=store.getWorkspaceSnapshot().media.url;gate.resolve(opened("a.bin"));expect(await old).toBeFalse();expect(a.closed).toEqual([opened("a.bin").handle]);expect(store.getWorkspaceSnapshot().media.url).toBe(url);expect(revoked).not.toContain(url);expect(b.closed).toEqual([opened("b.bin").handle]);
});
test("prepared text and SVG retain the original source roles",async()=>{await seed();expect(media.prepareWorkspaceMedia("code.ts",1)).toBe("text");expect(store.getWorkspaceSnapshot().media.role).toBe("text");expect(media.prepareWorkspaceMedia("icon.svg",1)).toBe("svg");expect(store.getWorkspaceSnapshot().media.role).toBe("svg");});
test("ready media retains the full workspace relative path used for reload",async()=>{await seed();media.prepareWorkspaceMedia("dir/a.bin",0);expect(await media.loadWorkspaceMedia("dir/a.bin")).toBeTrue();expect(store.getWorkspaceSnapshot().media.path).toBe("dir/a.bin");});
