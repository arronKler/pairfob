/**
 * Pairfob hosted mux operational load check.
 *
 * Live runs distribute one registered daemon WebSocket per DaemonRoom. A
 * credentials manifest is required above one socket so the harness exercises
 * the production sharding model instead of tripping one Room's hello cap.
 *
 *   bun scripts/load-mux.ts --dry-run
 *   bun scripts/load-mux.ts --origin http://127.0.0.1:8787 --n 1
 *   bun scripts/load-mux.ts --origin https://pairfob.com --credentials /secure/daemon-creds.json --n 10000
 */

import { stat } from "node:fs/promises";
import { ZERO_ROUTE } from "../workers/pairfob-origin/src/crypto.ts";
import { decode, Typ } from "../workers/pairfob-origin/src/envelope.ts";
import { encodeJSON, encodeRaw } from "../workers/pairfob-origin/src/frames.ts";

export interface LoadCredential {
  daemon_id: string;
  reconnect_token: string;
}

export interface LoadConfig {
  origin: string;
  target: string;
  credentialsPath: string;
  n: number;
  holdMs: number;
  concurrency: number;
  dryRun: boolean;
}

export const stages = [
  { n: 1_000, name: "1k smoke", note: "1,000 DaemonRooms; HELLO_DAEMON + envelope PING" },
  { n: 10_000, name: "10k soak", note: "10,000 DaemonRooms; watch GB-s/connection and alarm lateness" },
];

export function parseArgs(argv: string[]): LoadConfig {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "join-grant" || key.startsWith("join-grant=")) {
      throw new Error("--join-grant is not used");
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args.set(key, "1");
    else {
      args.set(key, next);
      i++;
    }
  }
  const n = parsePositiveInt(args.get("n") ?? "0", "n", true);
  const holdSeconds = parsePositiveInt(args.get("hold-seconds") ?? "5", "hold-seconds");
  const concurrency = parsePositiveInt(args.get("concurrency") ?? "100", "concurrency");
  const origin = normalizeHTTPOrigin(args.get("origin") ?? "");
  const target = normalizeTarget(args.get("target") ?? "", origin);
  const config: LoadConfig = {
    origin,
    target,
    credentialsPath: args.get("credentials") ?? "",
    n,
    holdMs: holdSeconds * 1_000,
    concurrency,
    dryRun: args.has("dry-run") || n === 0,
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: LoadConfig): void {
  if (config.dryRun) return;
  if (!config.origin) throw new Error("--origin is required for every live run, including --target runs");
  if (!config.target) throw new Error("a ws(s) /v2/ws target is required");
  if (!config.credentialsPath && config.n > 1) {
    throw new Error("n>1 requires --credentials");
  }
}

export function banner(config: LoadConfig): string {
  const lines = [
    "pairfob load-mux operational check",
    "This harness checks representative mux behavior and cost signals; it is not a capacity target or release gate.",
    "",
    "planned stages:",
    ...stages.map((stage) => `  - ${stage.name} (n=${stage.n}): ${stage.note}`),
    "",
    `origin=${config.origin || "(unset)"} target=${config.target || "(unset)"} n=${config.n || "(unset)"}`,
    `credentials=${config.credentialsPath ? "configured" : "(unset)"} dry=${config.dryRun}`,
  ];
  if (config.dryRun) lines.push("dry-run: no sockets opened.");
  return lines.join("\n") + "\n";
}

async function loadCredentials(config: LoadConfig): Promise<LoadCredential[]> {
  if (!config.credentialsPath) {
    return [await enroll(config.origin)];
  }
  const info = await stat(config.credentialsPath);
  if (!info.isFile()) throw new Error("--credentials must name a regular file");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("--credentials must not be readable by group or other users");
  }
  const parsed = JSON.parse(await Bun.file(config.credentialsPath).text()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("credentials manifest must be a JSON array");
  const credentials = parsed.map(validateCredential);
  if (credentials.length < config.n) {
    throw new Error(`credentials manifest has ${credentials.length} rows but n=${config.n}`);
  }
  return credentials.slice(0, config.n);
}

function validateCredential(value: unknown, index: number): LoadCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`credentials[${index}] must be an object`);
  }
  const row = value as Record<string, unknown>;
  const daemonId = typeof row.daemon_id === "string" ? row.daemon_id : "";
  const reconnectToken = typeof row.reconnect_token === "string" ? row.reconnect_token : "";
  if (!/^d_[0-9a-f]{20}$/.test(daemonId) || !/^rt_[0-9a-f]{32}$/.test(reconnectToken)) {
    throw new Error(`credentials[${index}] contains an invalid daemon credential`);
  }
  return { daemon_id: daemonId, reconnect_token: reconnectToken };
}

async function enroll(origin: string): Promise<LoadCredential> {
  const credential = {
    daemon_id: "d_" + randomHex(10),
    reconnect_token: "rt_" + randomHex(16),
  };
  const response = await fetch(`${origin}/v2/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ v: 2, ...credential }),
  });
  const body = await response.json() as { daemon_id?: string; reconnect_token?: string; error?: { code?: string } };
  if (!response.ok || body.daemon_id !== credential.daemon_id || body.reconnect_token !== credential.reconnect_token) {
    throw new Error(`enroll ${response.status} ${body.error?.code || "failed"}`);
  }
  return credential;
}

async function openDistributed(config: LoadConfig, credentials: LoadCredential[]): Promise<WebSocket[]> {
  const sockets = new Array<WebSocket>(credentials.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(config.concurrency, credentials.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= credentials.length) return;
      const credential = credentials[index];
      const url = `${config.target}?role=daemon&daemon_id=${encodeURIComponent(credential.daemon_id)}`;
      const socket = await openWS(url);
      sockets[index] = socket;
      await establishDaemon(socket, credential);
      socket.send(encodeRaw(Typ.PING, ZERO_ROUTE, crypto.getRandomValues(new Uint8Array(8))));
    }
  });
  try {
    await Promise.all(workers);
    return sockets;
  } catch (error) {
    for (const socket of sockets) socket?.close();
    throw error;
  }
}

function establishDaemon(socket: WebSocket, credential: LoadCredential): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new Error(`socket closed before HELLO_DAEMON ack for ${credential.daemon_id}`));
    const onError = () => finish(new Error(`socket failed before HELLO_DAEMON ack for ${credential.daemon_id}`));
    const onMessage = (event: MessageEvent) => {
      void messageBytes(event.data).then((bytes) => {
        const frame = decode(bytes);
        if (frame.typ !== Typ.HELLO_DAEMON) return;
        const body = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
        if (body.ok !== true || body.daemon_id !== credential.daemon_id || body.reconnect_token !== credential.reconnect_token) {
          finish(new Error(`HELLO_DAEMON rejected for ${credential.daemon_id}`));
          return;
        }
        finish();
      }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    const timeout = setTimeout(() => finish(new Error(`HELLO_DAEMON timeout for ${credential.daemon_id}`)), 10_000);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.send(encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: credential.daemon_id,
      reconnect_token: credential.reconnect_token,
    }));
  });
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error(`unexpected WebSocket message type: ${Object.prototype.toString.call(value)}`);
}

function openWS(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ["pairfob.v2"]);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error(`websocket open failed for ${new URL(url).origin}`)), { once: true });
  });
}

async function main(): Promise<void> {
  const config = parseArgs(Bun.argv.slice(2));
  process.stdout.write(banner(config));
  if (config.dryRun) return;
  const credentials = await loadCredentials(config);
  const sockets = await openDistributed(config, credentials);
  process.stdout.write(`opened ${sockets.length} sockets across ${sockets.length} DaemonRooms; holding ${config.holdMs}ms.\n`);
  await Bun.sleep(config.holdMs);
  for (const socket of sockets) socket.close();
}

function normalizeHTTPOrigin(raw: string): string {
  if (!raw) return "";
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("--origin must be an http(s) origin without path, query, or fragment");
  }
  return url.origin;
}

function normalizeTarget(raw: string, origin: string): string {
  const value = raw || (origin ? `${origin.replace(/^http/, "ws")}/v2/ws` : "");
  if (!value) return "";
  const url = new URL(value);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.pathname !== "/v2/ws" || url.search || url.hash) {
    throw new Error("--target must be a ws(s) URL ending at /v2/ws without query or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function parsePositiveInt(raw: string, name: string, allowZero = false): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
