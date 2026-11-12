import { describe, expect, test } from "bun:test";
import {
  normalizeRelayOrigin,
  parseRuntimeConfig,
  relayHostFor,
  relayURLFor,
  webSocketURLFor,
} from "./runtime-config.ts";

describe("relayHostFor", () => {
  test("names the relay the app is served from", () => {
    expect(relayHostFor("https://pairfob.com")).toBe("pairfob.com");
    expect(relayHostFor("https://relay.example.com")).toBe("relay.example.com");
    expect(relayHostFor("http://127.0.0.1:18786")).toBe("127.0.0.1");
  });

  test("falls back to the official host for an unreadable origin", () => {
    expect(relayHostFor("not an origin")).toBe("pairfob.com");
  });
});

describe("runtime config", () => {
  test("web mode keeps the page origin and ignores a native relay override", () => {
    expect(parseRuntimeConfig({}, "https://pairfob.com")).toEqual({
      mode: "web",
      relayOrigin: "https://pairfob.com",
    });
    expect(parseRuntimeConfig({ VITE_PAIRFOB_RELAY_ORIGIN: "https://evil.example" }, "https://pairfob.com"))
      .toEqual({ mode: "web", relayOrigin: "https://pairfob.com" });
  });

  test("web mode normalizes a trailing slash to an origin", () => {
    expect(parseRuntimeConfig({}, "https://pairfob.com/")).toEqual({
      mode: "web",
      relayOrigin: "https://pairfob.com",
    });
  });

  test("native mode requires the explicit flag and a relay origin", () => {
    expect(parseRuntimeConfig({}, "https://localhost")).toEqual({ mode: "web", relayOrigin: "https://localhost" });
    expect(() => parseRuntimeConfig({ VITE_PAIRFOB_NATIVE: "1" }, "https://localhost")).toThrow();
    expect(parseRuntimeConfig({
      VITE_PAIRFOB_NATIVE: "1",
      VITE_PAIRFOB_RELAY_ORIGIN: "https://pairfob.com/",
    }, "https://localhost")).toEqual({ mode: "native", relayOrigin: "https://pairfob.com" });
  });

  test("native mode allows a loopback http relay for local development", () => {
    expect(parseRuntimeConfig({
      VITE_PAIRFOB_NATIVE: "1",
      VITE_PAIRFOB_RELAY_ORIGIN: "http://127.0.0.1:18786",
    }, "http://localhost")).toEqual({ mode: "native", relayOrigin: "http://127.0.0.1:18786" });
  });

  test("web mode keeps a LAN http page origin for local network development", () => {
    expect(parseRuntimeConfig({}, "http://192.168.1.20:18786")).toEqual({
      mode: "web",
      relayOrigin: "http://192.168.1.20:18786",
    });
    expect(relayURLFor("http://192.168.1.20:18786", "/api/config")).toBe("http://192.168.1.20:18786/api/config");
    expect(webSocketURLFor("http://192.168.1.20:18786", "/v2/ws")).toBe("ws://192.168.1.20:18786/v2/ws");
  });

  test("native mode rejects a non-loopback http relay", () => {
    expect(() => parseRuntimeConfig({
      VITE_PAIRFOB_NATIVE: "1",
      VITE_PAIRFOB_RELAY_ORIGIN: "http://192.168.1.20:18786",
    }, "http://localhost")).toThrow();
  });

  test("a relay origin must be a bare absolute origin", () => {
    for (const value of [
      "pairfob.com",
      "ftp://pairfob.com",
      "https://pairfob.com/pair",
      "https://pairfob.com?x=1",
      "https://user:pass@pairfob.com",
      "https://pairfob.com/#fragment",
      "http://pairfob.com",
    ]) {
      expect(() => normalizeRelayOrigin(value)).toThrow();
    }
  });
});

describe("relay URL helpers", () => {
  test("builds absolute HTTP and WebSocket URLs on the relay, not the page", () => {
    expect(relayURLFor("https://pairfob.com", "/api/config")).toBe("https://pairfob.com/api/config");
    expect(relayURLFor("http://127.0.0.1:18786", "/v2/pair-intent")).toBe("http://127.0.0.1:18786/v2/pair-intent");
    expect(webSocketURLFor("https://pairfob.com", "/v2/ws?role=client"))
      .toBe("wss://pairfob.com/v2/ws?role=client");
    expect(webSocketURLFor("http://127.0.0.1:18786", "/v2/ws?role=client"))
      .toBe("ws://127.0.0.1:18786/v2/ws?role=client");
  });
});
