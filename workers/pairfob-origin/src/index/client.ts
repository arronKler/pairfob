import { indexName } from "../crockford.ts";
import type { PairIndexClient } from "../room/types.ts";

export class NamespaceIndexClient implements PairIndexClient {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(loc: string): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(indexName(loc)));
  }

  async lookup(loc: string): Promise<{ daemon_id: string; pair_ref: string; exp: number } | null> {
    const res = await this.stub(loc).fetch(
      new Request("https://pairfob.internal/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_loc: loc }),
      }),
    );
    if (!res.ok) {
      await discardResponse(res, "lookup");
      return null;
    }
    const j = (await res.json()) as { ok?: boolean; daemon_id?: string; pair_ref?: string; exp?: number };
    if (!j.ok || !j.daemon_id || !j.pair_ref) return null;
    return { daemon_id: j.daemon_id, pair_ref: j.pair_ref, exp: j.exp ?? 0 };
  }

  async insert(row: { pair_loc: string; daemon_id: string; pair_ref: string; exp: number }): Promise<"ok" | "conflict" | "fail"> {
    try {
      const res = await this.stub(row.pair_loc).fetch(
        new Request("https://pairfob.internal/insert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        }),
      );
      const result = res.status === 409 ? "conflict" : res.ok ? "ok" : "fail";
      await discardResponse(res, "insert");
      return result;
    } catch {
      return "fail";
    }
  }

  async remove(pair_loc: string, owner: { daemon_id: string; pair_ref: string }): Promise<void> {
    try {
      const res = await this.stub(pair_loc).fetch(
        new Request("https://pairfob.internal/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pair_loc, ...owner }),
        }),
      );
      await discardResponse(res, "delete");
    } catch {
      /* best-effort */
    }
  }
}

/** Release an unused body without changing the operation's established HTTP result. */
async function discardResponse(res: Response, action: "lookup" | "insert" | "delete"): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A cleanup failure does not undo a committed mutation. Do not retry it or
    // report it as an index rejection; keep the failure visible without payloads.
    try {
      console.warn(JSON.stringify({ kind: "pairfob", event: "index_response_cleanup_failed", action, status: res.status }));
    } catch {
      // Logging must not change the already known operation result either.
    }
  }
}
