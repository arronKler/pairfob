import { HELLO_GRACE_MS, PAIR_CONFIRM_MS, PAIR_FIRST_MS, RESUME_MS } from "../constants.ts";
import { sendErr } from "../frames.ts";
import { isRegisteredDaemon } from "./attachment.ts";
import type { RoomCore } from "./core.ts";
import type { AlarmKind, RoomStore } from "./types.ts";

export async function syncHeapAlarm(store: RoomStore): Promise<void> {
  const next = store.minAlarmAt();
  await store.setAlarmIfChanged(next);
}

export async function schedule(store: RoomStore, kind: AlarmKind, ref: string, at: number): Promise<void> {
  store.upsertAlarm(kind, ref, at);
  await syncHeapAlarm(store);
}

export async function clearKindRef(store: RoomStore, kind: AlarmKind, ref: string): Promise<void> {
  store.deleteAlarmsByKindRef(kind, ref);
  await syncHeapAlarm(store);
}

export async function harvestDue(room: RoomCore): Promise<void> {
  const now = room.now();
  const due = room.store.dueAlarms(now);
  const ids: number[] = [];
  for (const row of due) {
    room.noteAlarmLate(Math.max(0, now - row.at));
    if (row.id !== undefined) ids.push(row.id);
    await applyAlarm(room, row.kind, row.ref, now);
  }
  if (ids.length) room.store.deleteAlarmIds(ids);
  room.store.expireTickets(now);
}

async function applyAlarm(room: RoomCore, kind: AlarmKind, ref: string, now: number): Promise<void> {
  switch (kind) {
    case "hello_5s":
      closeExpiredHellos(room, now);
      return;
    case "resume_15s":
      closeExpiredResumes(room, now);
      return;
    case "pair_first_15s":
    case "pair_confirm_30s":
      timeoutPairing(room, ref, "pair_timeout", kind === "pair_first_15s" ? "pairing handshake did not start" : "pairing proof did not arrive");
      return;
    case "pair_ttl":
      await room.withPairingLock(() => expireSlot(room, ref));
      return;
    case "ticket_15s":
      room.store.expireTickets(now);
      return;
  }
}

function closeExpiredHellos(room: RoomCore, now: number): void {
  for (const ws of room.sockets()) {
    const a = room.att(ws);
    if (!a || a.mode !== "hello" || a.kind !== "none") continue;
    if (isRegisteredDaemon(a)) continue;
    const started = a.hello_at_ms || a.created_ms;
    if (started && now - started >= HELLO_GRACE_MS) {
      sendErr(ws, "unbound", "5s attach timeout");
      ws.close(1000, "unbound");
    }
  }
}

function closeExpiredResumes(room: RoomCore, now: number): void {
  for (const ws of room.sockets()) {
    const a = room.att(ws);
    if (a?.kind !== "resumehello") continue;
    if (now - a.created_ms > RESUME_MS) {
      room.closeBind(ws, "unpaired", "15s DeviceHello timeout");
    }
  }
}

function timeoutPairing(room: RoomCore, routeHex: string, code: string, message: string): void {
  const ws = room.findByRoute(routeHex);
  if (!ws) return;
  const a = room.att(ws);
  if (a?.kind !== "pairing") return;
  room.closeBind(ws, code, message);
}

async function expireSlot(room: RoomCore, pairRef: string): Promise<void> {
  const slot = room.store.loadSlot();
  if (!slot || slot.pair_ref !== pairRef || slot.deadline > room.now()) return;
  for (const ws of room.sockets()) {
    const a = room.att(ws);
    if (a?.kind === "pairing" && a.pair_ref === pairRef) {
      room.closeBind(ws, "unpaired", "pairing slot expired");
    }
  }
  if (room.daemon) sendErr(room.daemon, "pairing_expired", "pairing slot expired", { pairRef });
  const loc = slot.pair_loc;
  room.store.deleteSlot();
  await room.index()?.remove(loc, { daemon_id: room.daemonId, pair_ref: slot.pair_ref });
}

export async function armHello(room: RoomCore, ref: string, helloAt: number): Promise<void> {
  await schedule(room.store, "hello_5s", ref, helloAt + HELLO_GRACE_MS);
}

export async function armResume(room: RoomCore, routeHex: string, created: number): Promise<void> {
  await schedule(room.store, "resume_15s", routeHex, created + RESUME_MS);
}

export async function armPairFirst(room: RoomCore, routeHex: string, created: number): Promise<void> {
  await schedule(room.store, "pair_first_15s", routeHex, created + PAIR_FIRST_MS);
}

export async function advancePairFrames(room: RoomCore, routeHex: string, frames: number, slotDeadline: number): Promise<void> {
  if (frames === 1) {
    await schedule(room.store, "pair_confirm_30s", routeHex, room.now() + PAIR_CONFIRM_MS);
    room.store.deleteAlarmsByKindRef("pair_first_15s", routeHex);
    await syncHeapAlarm(room.store);
  } else if (frames === 2) {
    room.store.deleteAlarmsByKindRef("pair_first_15s", routeHex);
    room.store.deleteAlarmsByKindRef("pair_confirm_30s", routeHex);
    const remaining = Math.max(1000, slotDeadline - room.now());
    await schedule(room.store, "pair_confirm_30s", routeHex, room.now() + remaining);
  }
}
