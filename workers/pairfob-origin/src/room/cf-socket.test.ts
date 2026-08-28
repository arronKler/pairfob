import { describe, expect, test } from "bun:test";
import { newAttachment, type Attachment } from "./attachment.ts";
import { CfSocket, type HibernatingSocket } from "./cf-socket.ts";

describe("hibernating socket attachment cache", () => {
  test("deserializes once and keeps caller mutations isolated", () => {
    let stored: Attachment | null = newAttachment("phone", 100);
    let reads = 0;
    const raw: HibernatingSocket = {
      send() {},
      close() {},
      serializeAttachment(att) {
        stored = { ...att };
      },
      deserializeAttachment() {
        reads++;
        return stored ? { ...stored } : null;
      },
    };
    const socket = new CfSocket(raw);

    const first = socket.deserializeAttachment();
    expect(first?.kind).toBe("none");
    if (first) first.kind = "pairing";
    expect(socket.deserializeAttachment()?.kind).toBe("none");
    expect(reads).toBe(1);

    socket.serializeAttachment(newAttachment("phone", 200, { kind: "established", route_id: "ab".repeat(16) }));
    expect(socket.deserializeAttachment()?.kind).toBe("established");
    expect(reads).toBe(1);
  });
});
