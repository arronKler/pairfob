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
    if (!res.ok) return null;
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
      if (res.status === 409) return "conflict";
      if (!res.ok) return "fail";
      return "ok";
    } catch {
      return "fail";
    }
  }

  async remove(pair_loc: string, owner: { daemon_id: string; pair_ref: string }): Promise<void> {
    try {
      await this.stub(pair_loc).fetch(
        new Request("https://pairfob.internal/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pair_loc, ...owner }),
        }),
      );
    } catch {
      /* best-effort */
    }
  }
}
