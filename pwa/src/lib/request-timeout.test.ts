import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./protocol/errors.ts";
import { HTTP_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "./request-timeout.ts";

describe("bounded control-plane requests", () => {
  test("keeps a conservative default for slow mobile links", () => {
    expect(HTTP_REQUEST_TIMEOUT_MS).toBe(12_000);
  });

  test("aborts a stalled fetch at its deadline", async () => {
    let aborted = false;
    const error = await fetchWithTimeout(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        }, { once: true });
      });
    }, "/api/config", {}, { timeoutMs: 1 }).catch((caught) => caught);

    expect(aborted).toBeTrue();
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("timeout");
  });

  test("forwards caller cancellation without relabeling it as a timeout", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }, "/v2/pair-intent", {}, { timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught) => caught);

    expect(error).not.toBeInstanceOf(ProtocolError);
    expect(controller.signal.aborted).toBeTrue();
  });
});
