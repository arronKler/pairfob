import { normalizeLoc } from "../crockford.ts";
import { jsonResponse, readJSON } from "../http.ts";

interface LocRow {
  pair_loc: string;
  daemon_id: string;
  pair_ref: string;
  exp: number;
}

export class IndexCore {
  now: () => number;

  constructor(
    private readonly rows: Map<string, LocRow>,
    now: () => number,
    private readonly persist?: {
      load(): Map<string, LocRow>;
      put(row: LocRow): void;
      delete(loc: string): void;
    },
  ) {
    this.now = now;
    if (persist) {
      const loaded = persist.load();
      for (const [k, v] of loaded) this.rows.set(k, v);
    }
  }

  lookup(loc: string): LocRow | null {
    const row = this.rows.get(loc);
    if (!row) return null;
    if (row.exp <= this.now()) {
      this.rows.delete(loc);
      this.persist?.delete(loc);
      return null;
    }
    return { ...row };
  }

  insert(row: LocRow): "ok" | "conflict" {
    const existing = this.rows.get(row.pair_loc);
    if (!existing || existing.exp <= this.now()) {
      const next = { ...row };
      this.rows.set(row.pair_loc, next);
      this.persist?.put(next);
      return "ok";
    }
    if (existing.daemon_id === row.daemon_id && existing.pair_ref === row.pair_ref) {
      existing.exp = row.exp;
      this.persist?.put({ ...existing });
      return "ok";
    }
    return "conflict";
  }

  remove(loc: string, owner: { daemon_id: string; pair_ref: string }): void {
    const existing = this.rows.get(loc);
    if (!existing || existing.daemon_id !== owner.daemon_id || existing.pair_ref !== owner.pair_ref) return;
    this.rows.delete(loc);
    this.persist?.delete(loc);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await readJSON(req)) ?? {};
    const locRaw = typeof body.pair_loc === "string" ? body.pair_loc : "";
    const loc = normalizeLoc(locRaw) ?? locRaw;

    if (url.pathname === "/lookup" && req.method === "POST") {
      const row = this.lookup(loc);
      if (!row) return jsonResponse("dev", 404, { ok: false, error: { code: "unpaired" } });
      return jsonResponse("dev", 200, { ok: true, ...row });
    }
    if (url.pathname === "/insert" && req.method === "POST") {
      const daemon_id = typeof body.daemon_id === "string" ? body.daemon_id : "";
      const pair_ref = typeof body.pair_ref === "string" ? body.pair_ref : "";
      const exp = typeof body.exp === "number" ? body.exp : 0;
      const r = this.insert({ pair_loc: loc, daemon_id, pair_ref, exp });
      if (r === "conflict") return jsonResponse("dev", 409, { ok: false, error: { code: "conflict" } });
      return jsonResponse("dev", 200, { ok: true });
    }
    if (url.pathname === "/delete" && req.method === "POST") {
      const daemon_id = typeof body.daemon_id === "string" ? body.daemon_id : "";
      const pair_ref = typeof body.pair_ref === "string" ? body.pair_ref : "";
      this.remove(loc, { daemon_id, pair_ref });
      return jsonResponse("dev", 200, { ok: true });
    }
    return jsonResponse("dev", 404, { ok: false, error: { code: "unbound" } });
  }
}

export class PairingIndex {
  private readonly core: IndexCore;

  constructor(ctx: DurableObjectState, _env: unknown) {
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS locs (
      pair_loc TEXT PRIMARY KEY,
      daemon_id TEXT NOT NULL,
      pair_ref TEXT NOT NULL,
      exp INTEGER NOT NULL
    )`);
    const persist = {
      load(): Map<string, LocRow> {
        const m = new Map<string, LocRow>();
        const rows = sql.exec<LocRow>("SELECT pair_loc, daemon_id, pair_ref, exp FROM locs").toArray();
        for (const r of rows) m.set(r.pair_loc, r);
        return m;
      },
      put(row: LocRow): void {
        sql.exec(
          "INSERT INTO locs (pair_loc, daemon_id, pair_ref, exp) VALUES (?, ?, ?, ?) ON CONFLICT(pair_loc) DO UPDATE SET daemon_id = excluded.daemon_id, pair_ref = excluded.pair_ref, exp = excluded.exp",
          row.pair_loc,
          row.daemon_id,
          row.pair_ref,
          row.exp,
        );
      },
      delete(loc: string): void {
        sql.exec("DELETE FROM locs WHERE pair_loc = ?", loc);
      },
    };
    this.core = new IndexCore(new Map(), () => Date.now(), persist);
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
