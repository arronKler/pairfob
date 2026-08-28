import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { ZERO_ROUTE } from "../crypto.ts";
import { encodeJSON } from "../frames.ts";
import { onMessage } from "./ws.ts";
import { PAIR_REF, makeRoom } from "../testutil/make-room.ts";
import { UNPAIRED_BODY } from "../pair-intent.ts";
import { handleRoomFetch } from "./http.ts";

describe("pair ticket consume", () => {
  test("Upgrade consumes ticket once; second fails unpaired", async () => {
    const h = makeRoom();
    const token = "rt_" + "11".repeat(16);
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "11".repeat(8) });
    const d = h.accept("daemon");
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: h.core.daemonId,
        reconnect_token: token,
      }),
    );
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.PAIR_OPEN, ZERO_ROUTE, {
        v: 2,
        op: "CreatePairing",
        daemon_id: h.core.daemonId,
        pair_ref: PAIR_REF,
        ttl_s: 180,
      }),
    );
    const loc = h.store.loadSlot()!.pair_loc;
    const issued = await h.core.issueTicket(loc);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const first = h.core.consumeUpgrade(new URLSearchParams({ pair_ticket: issued.pair_ticket }), "client");
    expect(first.ok).toBe(true);
    const second = h.core.consumeUpgrade(new URLSearchParams({ pair_ticket: issued.pair_ticket }), "client");
    expect(second.ok).toBe(false);

    const res = await handleRoomFetch(
      h.core,
      new Request(
        `https://pairfob.com/v2/ws?role=client&daemon_id=${h.core.daemonId}&pair_ticket=${issued.pair_ticket}`,
        { headers: { Upgrade: "websocket" } },
      ),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNPAIRED_BODY);
  });
});
