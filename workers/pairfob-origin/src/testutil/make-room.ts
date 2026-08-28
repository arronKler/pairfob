import { sha256Hex } from "../crypto.ts";
import { decode } from "../envelope.ts";
import { IndexCore } from "../index/pairing-index.ts";
import type { Env } from "../env.ts";
import type { AnalyticsSink } from "../metrics.ts";
import { RoomCore } from "../room/core.ts";
import { FakeSocket, FakeSocketView } from "../room/fake-socket.ts";
import { MemoryStore } from "../room/memory-store.ts";
import type { PairIndexClient } from "../room/types.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./fake-ns.ts";

export const PAIR_REF = "4f7a2c9e1b0d88aa55cc3311abde7001";

export function asIndexClient(core: IndexCore): PairIndexClient {
  return {
    lookup: (loc) => Promise.resolve(core.lookup(loc)),
    insert: (row) => Promise.resolve(core.insert(row)),
    remove: (loc, owner) => {
      core.remove(loc, owner);
      return Promise.resolve();
    },
  };
}

export function makeRoom(
  daemonId = "d_" + "ab".repeat(10),
  index?: IndexCore,
  options?: { freshSocketViews?: boolean },
) {
  const sockets: FakeSocket[] = [];
  const store = new MemoryStore();
  const idx = index ?? new IndexCore(new Map(), () => clock.t);
  const clock = { t: 1_000_000 };
  idx.now = () => clock.t;
  const core = new RoomCore({
    daemonId,
    store,
    now: () => clock.t,
    randomBytes: (n) => {
      const b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return b;
    },
    sockets: () =>
      sockets
        .filter((s) => !s.closed)
        .map((s) => (options?.freshSocketViews ? new FakeSocketView(s) : s)),
    index: asIndexClient(idx),
  });

  function accept(role: "daemon" | "phone", params = new URLSearchParams()): { ok: true; ws: FakeSocket } | { ok: false; ws: null } {
    const r = core.consumeUpgrade(params, role);
    if (!r.ok) return { ok: false, ws: null };
    const ws = new FakeSocket(role + String(sockets.length));
    ws.serializeAttachment(r.attachment);
    sockets.push(ws);
    core.attachSocket(ws);
    return { ok: true, ws };
  }

  return {
    core,
    store,
    index: idx,
    sockets,
    accept,
    clock,
    tick(ms: number) {
      clock.t += ms;
    },
  };
}

export function lastJSON(ws: FakeSocket): { typ: number; body: Record<string, unknown>; routeId: Uint8Array } {
  const raw = ws.sent[ws.sent.length - 1];
  const f = decode(raw);
  return { typ: f.typ, body: JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>, routeId: f.routeId };
}

export async function enrollDaemon(room: ReturnType<typeof makeRoom>, token = "rt_" + "ab".repeat(16)): Promise<{ ws: FakeSocket; token: string }> {
  const hash = await sha256Hex(token);
  room.core.enroll({ reconnect_hash: hash, grant_id: "g_" + "aa".repeat(8) });
  const acc = room.accept("daemon");
  if (!acc.ok) throw new Error("daemon upgrade");
  return { ws: acc.ws, token };
}

export class FakeMetrics implements AnalyticsSink {
  readonly points: Array<{
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }> = [];

  writeDataPoint(event: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void {
    this.points.push({
      indexes: event.indexes ? [...event.indexes] : [],
      blobs: event.blobs ? [...event.blobs] : [],
      doubles: event.doubles ? [...event.doubles] : [],
    });
  }
}

export function testEnv(opts?: {
  d1?: FakeD1;
  rooms?: FakeRoomNamespace;
  index?: FakeIndexNamespace;
  enrollOpen?: string;
  assets?: Fetcher;
  signupOpen?: string;
  metrics?: FakeMetrics;
}): Env {
  const d1 = opts?.d1 ?? new FakeD1();
  const indexCore = new IndexCore(new Map(), () => Date.now());
  const index = opts?.index ?? new FakeIndexNamespace(indexCore);
  const rooms =
    opts?.rooms ??
    new FakeRoomNamespace((name) => makeRoom(name, index.core));
  return {
    DB: d1,
    DAEMON_ROOM: rooms,
    PAIRING_INDEX: index,
    METRICS: opts?.metrics ?? new FakeMetrics(),
    OPERATOR_TOKEN: "dev-operator",
    IP_HASH_PEPPER: "dev-pepper-not-for-prod",
    BUILD: "test",
    INTENT_PAD_MS: "0",
    ENROLL_OPEN: opts?.enrollOpen,
    ASSETS: opts?.assets,
    SIGNUP_OPEN: opts?.signupOpen,
  };
}
