import { describe, expect, test } from "bun:test";
import {
  composeDraftKey,
  composeDraftScopeFromNotice,
  sameComposeDraftScope,
  type ComposeDraftScope,
} from "./compose-draft-scope";

const agent: ComposeDraftScope = { daemonId: "daemon-a", paneId: "p1", mode: "agent" };

describe("compose draft scope", () => {
  test("treats daemon, pane, and input mode as one identity", () => {
    expect(sameComposeDraftScope(agent, { ...agent })).toBe(true);
    expect(composeDraftKey(agent)).toBe("daemon-a\0p1\0agent");
  });

  test("keeps computers, panes, and control/chat/full-terminal surfaces apart", () => {
    expect(sameComposeDraftScope(agent, { ...agent, daemonId: "daemon-b" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, paneId: "p2" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, mode: "guided" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, mode: "full" })).toBe(false);
  });

  test("builds a draft scope from a notice without inventing a pane", () => {
    expect(
      composeDraftScopeFromNotice(
        { phase: "live", screen: "pane", daemonId: "daemon-a", paneId: "p1" },
        "agent",
      ),
    ).toEqual(agent);
  });
});
