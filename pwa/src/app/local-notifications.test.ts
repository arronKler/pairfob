import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import "../../test-support/boot-dom";
import { bindLocalNotifications } from "./local-notifications";
import { applySnapshot, resetDashboard } from "../features/dashboard/catalog-store";
import { setCredential } from "../features/computers/catalog-store";
import { setPhase } from "../features/connection/connection-store";
import { disableLocalNotifications, enableLocalNotifications } from "../features/settings/local-push";
import { connectionDiagnostics } from "../lib/protocol/connection-diagnostics";
import type { PairResult } from "../lib/protocol/client";

const pair = { daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "device", fp: "fp" } as unknown as PairResult;

type Request = { id: string; method: string } & Record<string, unknown>;

function nativeFixture(permission: "granted" | "denied" | "prompt" = "granted", running = true) {
  const requests: Request[] = [];
  let failPost = false;
  let backgroundSync = running;
  const port = {
    postMessage(raw: string) {
      const request = JSON.parse(raw) as Request;
      requests.push(request);
      let ok = true;
      let value: unknown = {};
      if (request.method === "status") value = { permission, backgroundSync };
      else if (request.method === "requestPermission") value = { permission };
      else if (request.method === "setBackgroundSync") {
        backgroundSync = request.on === true;
        value = { backgroundSync };
      } else if (request.method === "post") {
        ok = !failPost;
        value = failPost ? undefined : { posted: true };
      } else if (request.method === "cancel") value = { cancelled: true };
      port.onmessage?.({ data: JSON.stringify({ id: request.id, ok, value }) });
    },
    onmessage: null as ((event: { data: string }) => void) | null,
  };
  return {
    port,
    requests,
    posts: () => requests.filter((request) => request.method === "post"),
    failPosts: () => { failPost = true; },
  };
}

function snapshot(paneId: string, status: string, label = "auth") {
  return {
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    panes: [{
      pane_id: paneId, workspace_id: "w1", agent: "claude", display_agent: "Claude",
      agent_status: status, label,
    }],
  };
}

function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
}
function show() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
}

let controller: AbortController;

async function setup(options: { visible?: boolean; live?: boolean; enabled?: boolean; persisted?: boolean; backgroundSyncRunning?: boolean } = {}) {
  const fixture = nativeFixture("granted", options.backgroundSyncRunning ?? true);
  (window as unknown as { PairfobNotify?: typeof fixture.port }).PairfobNotify = fixture.port;
  localStorage.clear();
  setCredential(pair);
  setPhase(options.live === false ? "resuming" : "live");
  if (options.visible) show(); else hide();
  if (options.persisted) localStorage.setItem("pairfob:localPush", JSON.stringify({ enabled: true, backgroundSync: true }));
  else if (options.enabled !== false) await enableLocalNotifications();
  fixture.requests.length = 0;
  controller = new AbortController();
  bindLocalNotifications(controller.signal);
  return fixture;
}

beforeEach(() => {
  resetDashboard();
  localStorage.clear();
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
  hide();
});

afterEach(async () => {
  controller?.abort();
  await disableLocalNotifications();
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
  setCredential(null);
  setPhase("boot");
  resetDashboard();
  localStorage.clear();
  setSystemTime();
});

test("a known status change into blocked raises a needs-you notice for that pane", async () => {
  const { posts } = await setup();
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(posts()).toHaveLength(1);
  const post = posts()[0];
  expect(post.title).toBe("Pairfob · 需要你处理");
  expect(post.body).toBe("Claude · auth");
  expect(post.tag).toBe("pairfob-pane-p1");
  expect(post.url).toBe("/pair#notify=1&d=d_aaaaaaaaaaaaaaaaaaaa&pane=p1");
});

test("working to done raises a completion notice", async () => {
  const { posts } = await setup();
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "done"));
  expect(posts()).toHaveLength(1);
  expect(posts()[0].title).toBe("Pairfob · 本轮结束");
});

test("an unknown previous status, an unchanged status and other edges stay quiet", async () => {
  const { posts } = await setup();
  applySnapshot(snapshot("p1", "blocked"));
  applySnapshot(snapshot("p1", "blocked", "renamed"));
  applySnapshot(snapshot("p1", "idle"));
  applySnapshot(snapshot("p1", "done"));
  expect(posts()).toHaveLength(0);
  // blocked -> working -> done is the only completion edge; done after idle is not.
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "done"));
  expect(posts()).toHaveLength(1);
});

test("a visible page shows the attention strip instead of a system notice", async () => {
  const { posts } = await setup({ visible: true });
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(posts()).toHaveLength(0);
});

test("a session that is not live, or notifications switched off, stays quiet", async () => {
  const resuming = await setup({ live: false });
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(resuming.posts()).toHaveLength(0);
  controller.abort();
  await disableLocalNotifications();

  const off = await setup({ enabled: false });
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(off.posts()).toHaveLength(0);
});

test("one pane and kind debounces for 30 seconds and then notifies again", async () => {
  const { posts } = await setup();
  const start = Date.now();
  setSystemTime(new Date(start));
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(posts()).toHaveLength(1);
  setSystemTime(new Date(start + 30_001));
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(posts()).toHaveLength(2);
});

test("a pane label falls back to the workspace, then the pane id", async () => {
  const { posts } = await setup();
  applySnapshot({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "working" }],
    workspaces: [{ workspace_id: "w1", label: "demo" }] });
  applySnapshot({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "blocked" }],
    workspaces: [{ workspace_id: "w1", label: "demo" }] });
  expect(posts()[0].body).toBe("claude · demo");
  applySnapshot({ panes: [{ pane_id: "pane-abcdefgh", workspace_id: "w2", agent: "claude", agent_status: "working" }] });
  applySnapshot({ panes: [{ pane_id: "pane-abcdefgh", workspace_id: "w2", agent: "claude", agent_status: "blocked" }] });
  expect(posts()[1].body).toBe("claude · abcdefgh");
});

test("a failed post records one diagnostic and later transitions still notify", async () => {
  const { posts, failPosts } = await setup();
  failPosts();
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const diagnostics = connectionDiagnostics().filter((record) => record.event === "notify_local_post");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].reason).toBe("failed");
  applySnapshot(snapshot("p2", "working"));
  failPosts();
  applySnapshot(snapshot("p2", "blocked"));
  expect(posts()).toHaveLength(2);
});

test("an aborted page lifetime stops raising notices", async () => {
  const { posts } = await setup();
  controller.abort();
  applySnapshot(snapshot("p1", "working"));
  applySnapshot(snapshot("p1", "blocked"));
  expect(posts()).toHaveLength(0);
});

test("booting with the choice persisted restores a lost background sync notification", async () => {
  const { requests } = await setup({ persisted: true, backgroundSyncRunning: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(requests.some((request) => request.method === "setBackgroundSync" && request.on === true)).toBeTrue();
});
