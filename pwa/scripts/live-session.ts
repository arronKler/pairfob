/** Drive the shipped PWA protocol client against a live relay. */
import { pairOverWS, sessionOverWS } from "../src/lib/protocol/client.ts";

const relay = process.env.PAIRFOB_RELAY_WS || "ws://127.0.0.1:18786/v2/ws?role=client";
const pairRef = process.env.PAIRFOB_PAIR_REF || "";
const code = process.env.PAIRFOB_PAIR_CODE || "7K3M9H2P";

const pair = await pairOverWS(relay, { pair_ref: pairRef || undefined }, code, {});
console.log("PAIRED", JSON.stringify({ deviceId: pair.deviceId, daemonId: pair.daemonId }));
const sess = await sessionOverWS(relay, pair);
const ping1 = await sess.ping(11);
console.log("PING1", JSON.stringify(ping1));
const snap1 = await sess.snapshot();
console.log("SNAPSHOT1", JSON.stringify(snap1));
const ping2 = await sess.ping(22);
console.log("PING2", JSON.stringify(ping2));
const snap2 = await sess.snapshot();
console.log("SNAPSHOT2", JSON.stringify(snap2));
sess.close();
