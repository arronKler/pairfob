import { beforeEach, describe, expect, test } from "bun:test";
import { resetLimits } from "./limits.ts";
import { handleFetch } from "./worker.ts";
import { IndexCore } from "./index/pairing-index.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";
import { UNPAIRED_BODY } from "./pair-intent.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";

beforeEach(() => resetLimits());

describe("worker /v2/ws", () => {
  test("pair_loc query never upgrades and does not touch Index or Room", async () => {
    const index = new IndexCore(new Map(), () => Date.now());
    const idxNs = new FakeIndexNamespace(index);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, index));
    const env = testEnv({ rooms, index: idxNs });
    const res = await handleFetch(
      new Request("https://pairfob.com/v2/ws?role=client&daemon_id=d_" + "ab".repeat(10) + "&pair_loc=WJ3K9M", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "pairfob.v2",
          Origin: "https://pairfob.com",
        },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNPAIRED_BODY);
    expect(rooms.fetchLog).toEqual([]);
    expect(idxNs.fetchLog).toEqual([]);
  });

  test("/v1/ws is 426", async () => {
    const env = testEnv();
    const res = await handleFetch(new Request("https://pairfob.com/v1/ws?role=client"), env);
    expect(res.status).toBe(426);
  });

  test("unknown daemon ids are rejected before a Room is activated", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const daemonId = "d_" + "cd".repeat(10);
    const req = new Request(`https://pairfob.com/v2/ws?role=client&daemon_id=${daemonId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "pairfob.v2",
        Origin: "https://pairfob.com",
      },
    });

    const res = await handleFetch(req, env);
    expect(res.status).toBe(400);
    expect(rooms.fetchLog).toEqual([]);
  });
});
