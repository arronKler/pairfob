import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NamespaceIndexClient } from "./client.ts";

const owner = { daemon_id: "d_" + "11".repeat(10), pair_ref: "22".repeat(16) };
const row = { pair_loc: "ABCDEF", ...owner, exp: 123_456 };

function namespace(fetch: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const names: string[] = [];
  const ns: DurableObjectNamespace = {
    idFromName(name) {
      names.push(name);
      return { name, toString: () => name, equals: (other) => other.name === name };
    },
    get: () => ({ fetch: async (request) => {
      const req = typeof request === "string" ? new Request(request) : request;
      requests.push(req);
      return fetch(req);
    } }),
  };
  return { client: new NamespaceIndexClient(ns), requests, names };
}

function unusedResponse(status: number, failure?: Error) {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      if (failure) throw failure;
    },
  });
  return { response: new Response(body, { status }), cancellations: () => cancellations };
}

const warnings: ReturnType<typeof spyOn>[] = [];
function captureWarning() {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  warnings.push(warning);
  return warning;
}
afterEach(() => {
  for (const warning of warnings.splice(0)) warning.mockRestore();
});

describe("index response ownership", () => {
  test.each([
    [200, "ok"], [409, "conflict"], [500, "fail"],
  ] as const)("insert releases status %i without changing its result", async (status, result) => {
    const body = unusedResponse(status);
    const h = namespace(async () => body.response);
    expect(await h.client.insert(row)).toBe(result);
    expect(body.cancellations()).toBe(1);
    expect(body.response.bodyUsed).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.names).toEqual(["idx:AB"]);
    expect(h.requests[0].url).toBe("https://pairfob.internal/insert");
    expect(await h.requests[0].json()).toEqual(row);
  });

  test.each([
    [200, "ok"], [409, "conflict"], [500, "fail"],
  ] as const)("insert preserves status %i even when releasing its body fails", async (status, result) => {
    const warning = captureWarning();
    const body = unusedResponse(status, new Error("private response data"));
    const h = namespace(async () => body.response);
    expect(await h.client.insert(row)).toBe(result);
    expect(body.cancellations()).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warning.mock.calls[0][0])).toEqual({
      kind: "pairfob", event: "index_response_cleanup_failed", action: "insert", status,
    });
  });

  test("insert fetch failures stay failures without retry", async () => {
    const h = namespace(async () => { throw new Error("fetch failed"); });
    expect(await h.client.insert(row)).toBe("fail");
    expect(h.requests).toHaveLength(1);
  });

  test("an absent response body needs no cleanup", async () => {
    const h = namespace(async () => new Response(null, { status: 204 }));
    expect(await h.client.insert(row)).toBe("ok");
    await h.client.remove(row.pair_loc, owner);
    expect(h.requests).toHaveLength(2);
  });

  test.each([200, 500])("remove releases status %i and preserves its request owner", async (status) => {
    const body = unusedResponse(status);
    const h = namespace(async () => body.response);
    await h.client.remove(row.pair_loc, owner);
    expect(body.cancellations()).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe("https://pairfob.internal/delete");
    expect(await h.requests[0].json()).toEqual({ pair_loc: row.pair_loc, ...owner });
  });

  test("remove cleanup and fetch failures remain best effort without retry", async () => {
    const warning = captureWarning();
    const body = unusedResponse(200, new Error("cleanup failed"));
    const h = namespace(async () => body.response);
    await h.client.remove(row.pair_loc, owner);
    expect(body.cancellations()).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ action: "delete", status: 200 });
    const failed = namespace(async () => { throw new Error("fetch failed"); });
    await failed.client.remove(row.pair_loc, owner);
    expect(failed.requests).toHaveLength(1);
  });

  test.each([404, 500])("lookup releases status %i before returning null", async (status) => {
    const body = unusedResponse(status);
    const h = namespace(async () => body.response);
    expect(await h.client.lookup(row.pair_loc)).toBeNull();
    expect(body.cancellations()).toBe(1);
    expect(h.requests).toHaveLength(1);
  });

  test("lookup cleanup failures preserve null and remain observable", async () => {
    const warning = captureWarning();
    const body = unusedResponse(404, new Error("cleanup failed"));
    const h = namespace(async () => body.response);
    expect(await h.client.lookup(row.pair_loc)).toBeNull();
    expect(body.cancellations()).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({ action: "lookup", status: 404 });
  });

  test("successful lookup consumes JSON instead of canceling it", async () => {
    const response = Response.json({ ok: true, ...owner, exp: row.exp });
    const cancel = spyOn(response.body!, "cancel");
    const h = namespace(async () => response);
    try {
      expect(await h.client.lookup(row.pair_loc)).toEqual({ ...owner, exp: row.exp });
      expect(response.bodyUsed).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(1);
    } finally {
      cancel.mockRestore();
    }
  });

  test("unsuccessful JSON results are still fully consumed", async () => {
    const response = Response.json({ ok: false });
    const h = namespace(async () => response);
    expect(await h.client.lookup(row.pair_loc)).toBeNull();
    expect(response.bodyUsed).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  test("lookup parse and fetch errors retain their failure semantics", async () => {
    const response = new Response("invalid JSON", { status: 200 });
    const h = namespace(async () => response);
    await expect(h.client.lookup(row.pair_loc)).rejects.toBeInstanceOf(SyntaxError);
    expect(response.bodyUsed).toBe(true);
    expect(h.requests).toHaveLength(1);
    const failure = new Error("lookup fetch failed");
    const failed = namespace(async () => { throw failure; });
    await expect(failed.client.lookup(row.pair_loc)).rejects.toBe(failure);
    expect(failed.requests).toHaveLength(1);
  });

  test("a successful lookup status cannot hide a response body read failure", async () => {
    const failure = new Error("response transport failed");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    const h = namespace(async () => response);
    await expect(h.client.lookup(row.pair_loc)).rejects.toBe(failure);
    expect(h.requests).toHaveLength(1);
    expect(response.bodyUsed).toBe(true);
  });

  test("cleanup diagnostics cannot turn a committed insert into failure", async () => {
    const warning = captureWarning().mockImplementation(() => { throw new Error("logger failed"); });
    const body = unusedResponse(200, new Error("cleanup failed"));
    const h = namespace(async () => body.response);
    expect(await h.client.insert(row)).toBe("ok");
    expect(body.cancellations()).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
  });
});
