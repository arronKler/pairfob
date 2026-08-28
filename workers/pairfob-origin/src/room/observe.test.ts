import { describe, expect, test } from "bun:test";
import { FWD_FLUSH_BYTES } from "../constants.ts";
import { makeRoom } from "../testutil/make-room.ts";
import { HEADER_SIZE } from "../envelope.ts";

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
});
