import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./session-ws.ts", import.meta.url)).text();

describe("session latency diagnostics", () => {
  test("measures an immediate content-free relay heartbeat and emits its RTT", () => {
    const transport = source.slice(source.indexOf("class SessionTransport"), source.indexOf("class ReconnectingSession"));
    expect(transport).toContain("beat();");
    expect(transport).toContain("performance.now() - this.expectedPongAt");
    expect(transport).toContain('this.emit({ type: "latency", rttMs })');
  });
});
