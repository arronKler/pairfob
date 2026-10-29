import { describe, expect, test } from "bun:test";
import { FWD_FLUSH_BYTES } from "../constants.ts";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { makeRoom } from "../testutil/make-room.ts";
import { HEADER_SIZE } from "../envelope.ts";
import { onMessage } from "./ws.ts";

describe("room metric hooks", () => {
  test("bind, close, and batched fwd bytes reach the sink", () => {
    const binds: string[] = [];
    const closes: Array<{ code: string; kind: string }> = [];
    const fwds: number[] = [];
    const h = makeRoom();
    h.core.deps.metrics = {
      bind(kind) {
        binds.push(kind);
      },
      close(code, kind) {
        closes.push({ code, kind });
      },
      fwd(bytes) {
        fwds.push(bytes);
      },
      reject() {},
      alarmLate() {},
    };

    h.core.noteBind("pairing");
    h.core.noteFwd(100);
    expect(h.core.fwdBytes).toBe(100);
    expect(fwds).toEqual([]);
    h.core.noteFwd(FWD_FLUSH_BYTES);
    expect(fwds).toEqual([100 + FWD_FLUSH_BYTES]);
    h.core.noteFwd(HEADER_SIZE);
    const daemon = h.accept("daemon");
    expect(daemon.ok).toBe(true);
    if (!daemon.ws) throw new Error("daemon upgrade");
    h.core.onClose(daemon.ws, "replaced");
    expect(fwds).toEqual([100 + FWD_FLUSH_BYTES, HEADER_SIZE]);
    expect(binds).toEqual(["pairing"]);
    expect(closes).toEqual([{ code: "replaced", kind: "daemon" }]);
  });

  test("a refused daemon hello reports its code", async () => {
    const rejects: Array<{ code: string; role: string }> = [];
    const h = makeRoom();
    h.core.deps.metrics = {
      bind() {},
      close() {},
      fwd() {},
      reject(code, role) {
        rejects.push({ code, role });
      },
      alarmLate() {},
    };
    const token = "rt_" + "ab".repeat(16);
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "ab".repeat(8) });
    const d = h.accept("daemon");
    expect(d.ok).toBe(true);
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: h.core.daemonId,
        reconnect_token: "rt_" + "cd".repeat(16),
      }),
    );
    expect(rejects).toEqual([{ code: "bad_token", role: "daemon" }]);
  });

  test("a hello to a room with no reconnect hash reports enroll_required", async () => {
    const rejects: Array<{ code: string; role: string }> = [];
    const h = makeRoom();
    h.core.deps.metrics = {
      bind() {},
      close() {},
      fwd() {},
      reject(code, role) {
        rejects.push({ code, role });
      },
      alarmLate() {},
    };
    const d = h.accept("daemon");
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: h.core.daemonId,
        reconnect_token: "rt_" + "ef".repeat(16),
      }),
    );
    expect(rejects).toEqual([{ code: "enroll_required", role: "daemon" }]);
  });
});
