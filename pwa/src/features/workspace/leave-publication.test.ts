import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { currentScreen, navigationStore, setScreen } from "../../app/navigation-store";
import { isAgentChat, isFullTerminal, openPaneId, selectPane, sessionStore, setAgentChat, setFullTerminal } from "../session/session-store";
import { setPhase } from "../connection/connection-store";
import { setCredential } from "../computers/catalog-store";
import { captureComposeDraft, resetComposeDrafts } from "../session/drafts/compose-drafts";
import { composeDraft, setComposeDraft } from "../session/compose-store";
import { resetWorkspaceNavigationSeam, restoreWorkspaceLeave } from "./navigation";

await resetTestDOM();

let stopped: Array<() => void> = [];

beforeEach(() => {
  resetWorkspaceNavigationSeam();
  resetComposeDrafts();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  // Original explicit baseline: anonymous credential so the owner/draft scope
  // never carries a previous fixture's PairResult daemon id.
  setCredential(null);
  setAgentChat(true);
  setFullTerminal(false);
  setComposeDraft("saved agent draft");
  stopped = [];
});

afterEach(() => {
  for (const stop of stopped) stop();
  resetWorkspaceNavigationSeam();
  resetComposeDrafts();
  setScreen("home");
  selectPane("");
  setAgentChat(false);
  setFullTerminal(false);
  setComposeDraft("");
});

test("workspace leave publication exposes restored draft together with pane and mode", () => {
  captureComposeDraft();
  setScreen("workspace");
  setAgentChat(false);
  setFullTerminal(true);
  setComposeDraft("");
  const seen: Array<{ pane: string; screen: string; agent: boolean; full: boolean; draft: string }> = [];
  const observe = () => seen.push({
    pane: openPaneId(),
    screen: currentScreen(),
    agent: isAgentChat(),
    full: isFullTerminal(),
    draft: composeDraft(),
  });
  stopped.push(navigationStore.subscribe(observe), sessionStore.subscribe(observe));
  restoreWorkspaceLeave("p1", "agent");
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((x) => x.screen === "pane" && x.pane === "p1" && x.agent && !x.full && x.draft === "saved agent draft")).toBeTrue();
  expect(composeDraft()).toBe("saved agent draft");
});

test("restoreWorkspaceLeave binds owner and draft inside the identity transaction", () => {
  const source = readFileSync(fileURLToPath(new URL("./navigation.ts", import.meta.url)), "utf8");
  const restore = source.slice(source.indexOf("export function restoreWorkspaceLeave"), source.indexOf("export function leaveWorkspaceToHome"));
  expect(restore.indexOf("seam.applyIdentity(")).toBeGreaterThan(restore.indexOf("batch(() => {"));
  expect(restore.indexOf("bindSessionOwnerFromLive()")).toBeGreaterThan(restore.indexOf("seam.applyIdentity("));
  expect(restore.indexOf("applyComposeDraft()")).toBeGreaterThan(restore.indexOf("bindSessionOwnerFromLive()"));
  expect(restore.indexOf("applyComposeDraft()")).toBeLessThan(restore.lastIndexOf("});"));
  expect(restore).not.toContain("sessionOwner()");
});