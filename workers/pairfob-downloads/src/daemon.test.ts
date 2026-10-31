import { expect, test } from "bun:test";
import worker from "./index";

const files = ["VERSION", "SHA256SUMS", "release.json", "pairfob-darwin-amd64", "pairfob-darwin-arm64", "pairfob-linux-amd64", "pairfob-linux-arm64",
  "pairfob-chat-darwin-amd64", "pairfob-chat-darwin-arm64", "pairfob-chat-linux-amd64", "pairfob-chat-linux-arm64"];

test("canonical and legacy daemon URLs stream the same assets without redirects or stale caching", async () => {
  for (const name of files) {
    for (const prefix of ["https://dl.pairfob.com/daemon/", "https://pairfob.com/dl/"]) {
      let seen = "";
      const response = await worker.fetch(new Request(`${prefix}${name}?check=1`), {
        ASSETS: { fetch: async (req: Request) => {
          seen = req.url;
          return new Response(`bytes:${name}`, { headers: { "Cache-Control": "public, max-age=3600", ETag: '"sha"' } });
        } },
      });
      expect(seen).toBe(`https://dl.pairfob.com/daemon/${name}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`bytes:${name}`);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("ETag")).toBe('"sha"');
    }
  }
});

test("installer aliases use the same script and HEAD/range semantics survive", async () => {
  for (const host of ["dl.pairfob.com", "pairfob.com"]) {
    const response = await worker.fetch(new Request(`https://${host}/install.sh`, {
      method: "HEAD", headers: { Range: "bytes=0-1" },
    }), { ASSETS: { fetch: async (req: Request) => {
      expect(req.method).toBe("HEAD");
      expect(req.headers.get("Range")).toBe("bytes=0-1");
      expect(req.url).toBe("https://dl.pairfob.com/install.sh");
      return new Response(null, { status: 206, headers: { "Content-Range": "bytes 0-1/10" } });
    } } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-1/10");
  }
});

test("daemon version CORS grants only the app and official web origins, including errors", async () => {
  for (const origin of ["https://localhost", "https://pairfob.com", "https://evil.example"]) {
    for (const status of [200, 404, 503]) {
      const response = await worker.fetch(new Request("https://dl.pairfob.com/daemon/VERSION", { headers: { Origin: origin } }), {
        ASSETS: { fetch: async () => new Response("version", { status }) },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin === "https://evil.example" ? null : origin);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Vary")).toBe("Origin");
      expect(response.status).toBe(status);
    }
  }
});

test("unknown daemon assets and write methods fail closed without reading assets", async () => {
  const env = { ASSETS: { fetch: async () => { throw new Error("must not read asset"); } } };
  for (const path of ["/daemon/private.key", "/daemon/", "/dl/VERSION.bak", "/dl/pairfob-unknown", "/install.sh.bak", "/v2/ws"]) {
    expect((await worker.fetch(new Request(`https://dl.pairfob.com${path}`), env)).status).toBe(404);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await worker.fetch(new Request("https://dl.pairfob.com/daemon/VERSION", { method }), env);
    expect(response.status).toBe(405);
  }
  const options = await worker.fetch(new Request("https://pairfob.com/dl/VERSION", {
    method: "OPTIONS", headers: { Origin: "https://localhost" },
  }), env);
  expect(options.status).toBe(204);
  expect(options.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
});
