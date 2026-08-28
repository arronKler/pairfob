import { base64Encode, concat } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";

export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MAX_COLS = 320;
export const TERMINAL_MIN_ROWS = 5;
export const TERMINAL_MAX_ROWS = 160;
export const TERMINAL_INPUT_CHUNK = 24 * 1024;
export const TERMINAL_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export type TerminalOpenResult = {
  operationId: string;
  terminalId: string;
  paneId: string;
  cols: number;
  rows: number;
  encoding: "ansi";
};

export type TerminalFramePart = {
  terminalId: string;
  sequence: string;
  width: number;
  height: number;
  full: boolean;
  index: number;
  count: number;
  data: Uint8Array;
};

export type TerminalFrame = Omit<TerminalFramePart, "index" | "count">;

export type TerminalCommandResult = {
  operationId: string;
  terminalId: string;
  acceptedSequence: number;
};

const TERMINAL_ID = /^term_[0-9a-f]{32}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("bad_message", `${label} 不是对象`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ProtocolError("bad_message", "Terminal 响应字段不匹配");
  }
}

function dimension(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ProtocolError("bad_message", `${label} 超出范围`);
  }
  return value as number;
}

export function parseTerminalOpenResult(value: unknown, expectedPaneId: string, expectedOperationId: string): TerminalOpenResult {
  const result = record(value, "TerminalOpen 响应");
  exact(result, ["operation_id", "terminal_id", "pane_id", "cols", "rows", "encoding"]);
  if (result.operation_id !== expectedOperationId
    || typeof result.terminal_id !== "string" || !TERMINAL_ID.test(result.terminal_id)
    || typeof result.pane_id !== "string" || !RESOURCE_ID.test(result.pane_id) || result.pane_id !== expectedPaneId
    || result.encoding !== "ansi") {
    throw new ProtocolError("bad_message", "TerminalOpen 标识不匹配");
  }
  return {
    operationId: expectedOperationId,
    terminalId: result.terminal_id,
    paneId: result.pane_id,
    cols: dimension(result.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, "cols"),
    rows: dimension(result.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, "rows"),
    encoding: "ansi",
  };
}

export function encodeTerminalInput(data: Uint8Array): string {
  if (!data.length || data.length > 32 * 1024) throw new ProtocolError("too_large", "单次终端输入超过限制");
  return base64Encode(data);
}

export function parseTerminalCommandResult(
  value: unknown,
  expectedOperationId: string,
  expectedTerminalId: string,
  expectedSequence: number,
): TerminalCommandResult {
  const result = record(value, "Terminal 命令响应");
  exact(result, ["operation_id", "terminal_id", "accepted_seq", "duplicate"]);
  if (result.operation_id !== expectedOperationId || result.terminal_id !== expectedTerminalId
    || result.accepted_seq !== expectedSequence || result.duplicate !== false) {
    throw new ProtocolError("bad_message", "Terminal 命令确认不匹配");
  }
  return {
    operationId: expectedOperationId,
    terminalId: expectedTerminalId,
    acceptedSequence: dimension(result.accepted_seq, 1, Number.MAX_SAFE_INTEGER, "accepted_seq"),
  };
}

export function parseTerminalCloseResult(value: unknown, expectedOperationId: string, expectedTerminalId: string): void {
  const result = record(value, "TerminalClose 响应");
  exact(result, ["operation_id", "terminal_id", "closed"]);
  if (result.operation_id !== expectedOperationId || result.terminal_id !== expectedTerminalId || result.closed !== true) {
    throw new ProtocolError("bad_message", "TerminalClose 确认不匹配");
  }
}

type PendingFrame = {
  terminalId: string;
  sequence: string;
  width: number;
  height: number;
  full: boolean;
  count: number;
  next: number;
  bytes: number;
  parts: Uint8Array[];
};

/** Reassemble one ordered server frame while bounding memory and metadata. */
export class TerminalFrameAssembler {
  private pending: PendingFrame | null = null;

  reset(): void {
    this.pending = null;
  }

  push(part: TerminalFramePart): TerminalFrame | null {
    const current = this.pending;
    if (!current) {
      if (part.index !== 0) throw new ProtocolError("bad_message", "终端帧缺少首片");
      this.pending = {
        terminalId: part.terminalId, sequence: part.sequence, width: part.width, height: part.height,
        full: part.full, count: part.count, next: 0, bytes: 0, parts: [],
      };
    } else if (current.terminalId !== part.terminalId || current.sequence !== part.sequence
      || current.width !== part.width || current.height !== part.height || current.full !== part.full
      || current.count !== part.count) {
      throw new ProtocolError("bad_message", "终端帧分片元数据发生变化");
    }
    const pending = this.pending;
    if (!pending || part.index !== pending.next) throw new ProtocolError("bad_message", "终端帧分片乱序");
    pending.parts.push(part.data);
    pending.bytes += part.data.byteLength;
    pending.next++;
    if (pending.bytes > TERMINAL_FRAME_MAX_BYTES) {
      this.pending = null;
      throw new ProtocolError("too_large", "终端帧超过内存限制");
    }
    if (pending.next < pending.count) return null;
    this.pending = null;
    return {
      terminalId: pending.terminalId, sequence: pending.sequence, width: pending.width,
      height: pending.height, full: pending.full, data: concat(...pending.parts),
    };
  }
}
