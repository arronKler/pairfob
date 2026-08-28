import { IndexCore } from "../index/pairing-index.ts";
import type { Attachment } from "../room/attachment.ts";
import type { RoomCore } from "../room/core.ts";
import { FakeSocket } from "../room/fake-socket.ts";
import { handleRoomFetch } from "../room/http.ts";
import type { makeRoom } from "./make-room.ts";

export class FakeId {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
  equals(other: DurableObjectId): boolean {
    return this.toString() === other.toString();
  }
}

export type RoomHarness = ReturnType<typeof makeRoom>;

export class FakeRoomNamespace implements DurableObjectNamespace {
  readonly harnesses = new Map<string, RoomHarness>();
  readonly fetchLog: string[] = [];
  factory: (name: string) => RoomHarness;
  failEnroll = false;
  failKick = false;

  constructor(factory: (name: string) => RoomHarness) {
    this.factory = factory;
  }

  idFromName(name: string): DurableObjectId {
    return new FakeId(name);
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = id.toString();
    return {
      fetch: async (request: Request | string, init?: RequestInit) => {
        const req = typeof request === "string" ? new Request(request, init) : request;
        this.fetchLog.push(new URL(req.url).pathname + new URL(req.url).search);
        if (this.failEnroll && new URL(req.url).pathname === "/internal/enroll") {
          return new Response("no", { status: 500 });
        }
        if (this.failKick && new URL(req.url).pathname === "/internal/kick") {
          return new Response("no", { status: 500 });
        }
        let h = this.harnesses.get(name);
        if (!h) {
          h = this.factory(name);
          this.harnesses.set(name, h);
        }
        return handleRoomFetch(h.core, req, {
          upgrade: (att: Attachment, _tags: string[], headers: Headers) => {
            const ws = new FakeSocket(name + ":" + h!.sockets.length);
            ws.serializeAttachment(att);
            h!.sockets.push(ws);
            h!.core.attachSocket(ws);
            return new Response(null, { status: 101, headers });
          },
        });
      },
    };
  }

  room(name: string): RoomCore | undefined {
    return this.harnesses.get(name)?.core;
  }

  harness(name: string): RoomHarness | undefined {
    return this.harnesses.get(name);
  }
}

export class FakeIndexNamespace implements DurableObjectNamespace {
  readonly core: IndexCore;
  readonly fetchLog: string[] = [];

  constructor(core: IndexCore) {
    this.core = core;
  }

  idFromName(name: string): DurableObjectId {
    return new FakeId(name);
  }

  get(_id: DurableObjectId): DurableObjectStub {
    return {
      fetch: async (request: Request | string, init?: RequestInit) => {
        const req = typeof request === "string" ? new Request(request, init) : request;
        this.fetchLog.push(new URL(req.url).pathname);
        return this.core.fetch(req);
      },
    };
  }
}
