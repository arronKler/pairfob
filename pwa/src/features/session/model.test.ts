import { describe, expect, test } from "bun:test";
import { composeDraftMode, sessionViewKind } from "./model";

describe("session view kind", () => {
  test("selects full, agent, or guided from exclusive flags", () => {
    expect(sessionViewKind({})).toBe("guided");
    expect(sessionViewKind({ agentChat: true })).toBe("agent");
    expect(sessionViewKind({ fullTerminal: true })).toBe("full");
    expect(sessionViewKind({ agentChat: true, fullTerminal: true })).toBe("full");
  });

  test("compose draft identity prefers agent chat over complete-terminal", () => {
    expect(composeDraftMode({})).toBe("guided");
    expect(composeDraftMode({ agentChat: true })).toBe("agent");
    expect(composeDraftMode({ fullTerminal: true })).toBe("full");
    expect(composeDraftMode({ agentChat: true, fullTerminal: true })).toBe("agent");
  });
});
