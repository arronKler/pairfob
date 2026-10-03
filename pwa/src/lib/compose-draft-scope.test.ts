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
    expect(composeDraftKey(agent)).toBe("daemon-a\0\0p1\0agent");
    // Absent and null both name the default Herdr session.
    expect(sameComposeDraftScope(agent, { ...agent, herdSession: null })).toBe(true);
    expect(composeDraftKey({ ...agent, herdSession: null })).toBe(composeDraftKey(agent));
  });

  test("keeps computers, panes, and control/chat/full-terminal surfaces apart", () => {
    expect(sameComposeDraftScope(agent, { ...agent, daemonId: "daemon-b" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, paneId: "p2" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, mode: "guided" })).toBe(false);
    expect(sameComposeDraftScope(agent, { ...agent, mode: "full" })).toBe(false);
  });

  test("keeps the same pane id apart across Herdr sessions", () => {
    // Herdr numbers panes per session, so w1:p1 exists in each one.
    const work = { ...agent, herdSession: "work" };
    expect(sameComposeDraftScope(agent, work)).toBe(false);
    expect(sameComposeDraftScope(work, { ...work, herdSession: "other" })).toBe(false);
    expect(composeDraftKey(work)).not.toBe(composeDraftKey(agent));
  });

  test("builds a draft scope from a notice without inventing a pane", () => {
    expect(
      composeDraftScopeFromNotice(
        { phase: "live", screen: "pane", daemonId: "daemon-a", paneId: "p1" },
        "agent",
      ),
    ).toEqual({ ...agent, herdSession: null });
    expect(
      composeDraftScopeFromNotice(
        { phase: "live", screen: "pane", daemonId: "daemon-a", herdSession: "work", paneId: "p1" },
        "agent",
      ),
    ).toEqual({ ...agent, herdSession: "work" });
  });
});
