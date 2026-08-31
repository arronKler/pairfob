import { base64Decode } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type TerminalFramePart,
} from "./terminal.ts";

const RPC_ERROR_CODES = new Set([
  "unpaired", "revoked", "pane_not_found", "tab_not_found", "workspace_not_found", "stale_prompt",
  "invalid_key", "herdr_offline", "too_large", "rate_limited", "unknown_op", "backpressure",
  "bad_token", "bad_frame", "internal", "pair_busy", "pair_timeout", "unbound", "wrong_ws", "too_many_devices",
  "kicked", "daemon_offline", "replay", "sas_required", "fp_mismatch", "forbidden",
  "invalid_argument", "unsupported", "conflict", "agent_not_found", "worktree_not_found",
  "transcript_unavailable", "unknown_outcome", "partial_failure",
]);
const POKE_REASONS = new Set(["agent_status", "herdr_offline", "herdr_online", "daemon_replaced"]);

export type ValidSessionMessage =
  | { kind: "request"; id: string; tMs: number }
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { kind: "poke"; reason: string; paneId?: string }
  | { kind: "terminal_frame"; frame: TerminalFramePart }
  | { kind: "terminal_closed"; terminalId: string; reason: string };

const TERMINAL_ID = /^term_[0-9a-f]{32}$/;
const TERMINAL_SEQUENCE = /^[1-9][0-9]{0,19}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

/** Validate decrypted server messages before they affect RPC state or UI. */
export function validateSessionMessage(value: unknown): ValidSessionMessage {
  if (!isRecord(value) || value.v !== 1) throw new ProtocolError("bad_message", "RPC 消息格式错误");
  if (value.op === "Poke") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["reason"], ["pane_id"])
      || typeof value.params.reason !== "string" || !POKE_REASONS.has(value.params.reason)
      || (value.params.pane_id !== undefined && (typeof value.params.pane_id !== "string" || value.params.pane_id.length < 1 || value.params.pane_id.length > 256))) {
      throw new ProtocolError("bad_message", "Poke 格式错误");
    }
    return { kind: "poke", reason: value.params.reason, ...(value.params.pane_id === undefined ? {} : { paneId: value.params.pane_id }) };
  }
  if (value.op === "TerminalFrame") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["terminal_id", "seq", "width", "height", "full", "index", "count", "data"])
      || typeof value.params.terminal_id !== "string" || !TERMINAL_ID.test(value.params.terminal_id)
      || typeof value.params.seq !== "string" || !TERMINAL_SEQUENCE.test(value.params.seq)
      || !Number.isSafeInteger(value.params.width) || (value.params.width as number) < TERMINAL_MIN_COLS || (value.params.width as number) > TERMINAL_MAX_COLS
      || !Number.isSafeInteger(value.params.height) || (value.params.height as number) < TERMINAL_MIN_ROWS || (value.params.height as number) > TERMINAL_MAX_ROWS
      || typeof value.params.full !== "boolean"
      || !Number.isSafeInteger(value.params.index) || (value.params.index as number) < 0
      || !Number.isSafeInteger(value.params.count) || (value.params.count as number) < 1 || (value.params.count as number) > 43
      || (value.params.index as number) >= (value.params.count as number)
      || typeof value.params.data !== "string" || value.params.data.length > 131_072) {
      throw new ProtocolError("bad_message", "TerminalFrame 格式错误");
    }
    let data: Uint8Array;
    try {
      data = base64Decode(value.params.data);
    } catch {
      throw new ProtocolError("bad_message", "TerminalFrame data 不是规范 Base64");
    }
    return {
      kind: "terminal_frame",
      frame: {
        terminalId: value.params.terminal_id,
        sequence: value.params.seq,
        width: value.params.width as number,
        height: value.params.height as number,
        full: value.params.full,
        index: value.params.index as number,
        count: value.params.count as number,
        data,
      },
    };
  }
  if (value.op === "TerminalClosed") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["terminal_id", "reason"])
      || typeof value.params.terminal_id !== "string" || !TERMINAL_ID.test(value.params.terminal_id)
      || typeof value.params.reason !== "string" || value.params.reason.length > 512) {
      throw new ProtocolError("bad_message", "TerminalClosed 格式错误");
    }
    return { kind: "terminal_closed", terminalId: value.params.terminal_id, reason: value.params.reason };
  }
  if (typeof value.op === "string") {
    if (!exactKeys(value, ["v", "id", "op", "params"]) || value.op !== "Ping"
      || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128
      || !isRecord(value.params) || !exactKeys(value.params, ["t_ms"])
      || !Number.isSafeInteger(value.params.t_ms)) {
      throw new ProtocolError("bad_message", "daemon RPC 请求格式错误");
    }
    return { kind: "request", id: value.id, tMs: value.params.t_ms as number };
  }
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128 || typeof value.ok !== "boolean") {
    throw new ProtocolError("bad_message", "RPC 响应格式错误");
  }
  if (value.ok) {
    if (!exactKeys(value, ["v", "id", "ok", "result"])) throw new ProtocolError("bad_message", "RPC 成功响应格式错误");
    return { kind: "response", id: value.id, ok: true, result: value.result };
  }
  if (!exactKeys(value, ["v", "id", "ok", "error"]) || !isRecord(value.error)
    || !exactKeys(value.error, ["code", "message"])
    || typeof value.error.code !== "string" || !RPC_ERROR_CODES.has(value.error.code)
    || typeof value.error.message !== "string" || value.error.message.length > 4096) {
    throw new ProtocolError("bad_message", "RPC 错误响应格式错误");
  }
  return { kind: "response", id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
}
