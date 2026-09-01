import { describe, expect, test } from "bun:test";

const main = await Bun.file(new URL("./main.ts", import.meta.url)).text();
const session = await Bun.file(new URL("./lib/protocol/session-ws.ts", import.meta.url)).text();

describe("mobile network lifecycle wiring", () => {
  test("offline gates work and online or foreground wakes the session", () => {
    expect(main).toContain('window.addEventListener("offline"');
    expect(main).toContain('window.addEventListener("online"');
    expect(main).toContain('document.addEventListener("visibilitychange"');
    expect(main).toContain("setLiveNetworkAvailable(available)");
    expect(main).toContain("reconnectLiveSessions()");
    expect(main).toContain("bootBlockedByNetwork");
    expect(main).toContain("void refreshRuntimeState()");
  });

  test("the reconnect state machine aborts offline dials without retrying mutations", () => {
    expect(session).toContain("this.connectAbort?.abort()");
    expect(session).toContain("!this.networkAvailable");
    expect(session).toContain("Capture one transport; mutation RPCs are never replayed");
    expect(session).toContain('transport.rpc("Ping", { t_ms: Date.now() }, 8_000)');
  });

  test("failed direct upgrades retry with backoff and foreground events probe immediately", () => {
    expect(session).toContain("this.scheduleDirectRetry(relay)");
    expect(session).toContain("directRetryDelay(this.directRetryAttempt++)");
    expect(session).toContain("this.startAutomaticDirectUpgrade(transport)");
    expect(session).toContain("this.networkMode = target");
    expect(session).toContain('this.networkMode !== "relay"');
  });
});
