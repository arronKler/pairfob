import type { Env } from "./env.ts";
import { PairingIndex } from "./index/pairing-index.ts";
import { DaemonRoom } from "./room/room.ts";
import { handleFetch } from "./worker.ts";

export { DaemonRoom, PairingIndex };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
};
