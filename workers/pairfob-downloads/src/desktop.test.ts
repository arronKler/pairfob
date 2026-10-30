import { expect, test } from "bun:test";
import worker from "./index";

const files = [
  ["release.json", "application/json; charset=utf-8"],
  ["VERSION", "text/plain; charset=utf-8"],
  ["SHA256SUMS", "text/plain; charset=utf-8"],
  ["pairfob-desktop-darwin-amd64", "application/octet-stream"],
  ["pairfob-desktop-darwin-arm64", "application/octet-stream"],
  ["pairfob-desktop-linux-amd64", "application/octet-stream"],
  ["pairfob-desktop-linux-arm64", "application/octet-stream"],
] as const;

test("desktop assets stream from the canonical path without caching", async () => {
  for (const [name, type] of files) {
    let seen = "";
    const response = await worker.fetch(
      new Request(`https://dl.pairfob.com/desktop/${name}?ignored=1`),
      {
        ASSETS: {
          fetch: async (req: Request) => {
            seen = req.url;
            return new Response(`bytes:${name}`, {
              headers: { "Cache-Control": "public, max-age=31536000, immutable", ETag: '"sha"' },
            });
          },
        },
      },
    );
    expect(seen).toBe(`https://dl.pairfob.com/desktop/${name}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`bytes:${name}`);
    expect(response.headers.get("Content-Type")).toBe(type);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBe('"sha"');
  }
});

test("unknown desktop paths fail closed without reading assets", async () => {
  const env = {
    ASSETS: {
      fetch: async () => {
        throw new Error("must not read an asset");
      },
    },
  };
  for (const path of [
    "/desktop/",
    "/desktop",
    "/desktop/private.key",
    "/desktop/%252e%252e/daemon/VERSION",
    "/desktop/release.json.bak",
    "/desktop/pairfob-desktop-windows-amd64",
  ]) {
    expect((await worker.fetch(new Request(`https://dl.pairfob.com${path}`), env)).status).toBe(404);
  }
});

test("desktop write methods are rejected without reading assets", async () => {
  const env = {
    ASSETS: {
      fetch: async () => {
        throw new Error("must not read an asset");
      },
    },
  };
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await worker.fetch(
      new Request("https://dl.pairfob.com/desktop/VERSION", { method }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const options = await worker.fetch(
    new Request("https://dl.pairfob.com/desktop/release.json", { method: "OPTIONS" }),
    env,
  );
  expect(options.status).toBe(204);
  expect(options.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
});

test("desktop HEAD requests keep headers but carry no body", async () => {
  const response = await worker.fetch(
    new Request("https://dl.pairfob.com/desktop/pairfob-desktop-darwin-arm64", {
      method: "HEAD",
    }),
    { ASSETS: { fetch: async (req: Request) => new Response(`bytes:${req.method}`, { status: 200 }) } },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("a missing desktop artifact is still uncached and typed", async () => {
  const response = await worker.fetch(
    new Request("https://dl.pairfob.com/desktop/pairfob-desktop-linux-amd64"),
    { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } },
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
});