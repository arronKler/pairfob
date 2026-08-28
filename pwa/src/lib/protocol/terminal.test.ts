import { describe, expect, test } from "bun:test";
import { base64Decode, base64Encode } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { parseTerminalCloseResult, parseTerminalCommandResult, parseTerminalOpenResult, TerminalFrameAssembler } from "./terminal.ts";

const terminalId = "term_0123456789abcdef0123456789abcdef";

describe("terminal protocol", () => {
  test("standard Base64 is canonical and binary-safe", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    expect(base64Encode(bytes)).toBe("AAECf4D/");
    expect(base64Decode("AAECf4D/")).toEqual(bytes);
    expect(() => base64Decode("AAECf4D_")).toThrow("base64");
    expect(() => base64Decode("AB==")).toThrow("canonical");
  });

  test("TerminalOpen binds the pane and operation id", () => {
    const result = {
      operation_id: "op_0123456789abcdef",
      terminal_id: terminalId,
      pane_id: "w0:p1",
      cols: 80,
      rows: 24,
      encoding: "ansi",
    };
    expect(parseTerminalOpenResult(result, "w0:p1", result.operation_id)).toEqual({
      operationId: result.operation_id,
      terminalId,
      paneId: "w0:p1",
      cols: 80,
      rows: 24,
      encoding: "ansi",
    });
    expect(() => parseTerminalOpenResult(result, "w0:p2", result.operation_id)).toThrow(ProtocolError);
    expect(() => parseTerminalOpenResult(result, "w0:p1", "op_fedcba9876543210")).toThrow(ProtocolError);
  });

  test("reassembles only ordered parts with stable metadata", () => {
    const assembler = new TerminalFrameAssembler();
    const base = { terminalId, sequence: "7", width: 80, height: 24, full: true, count: 2 };
    expect(assembler.push({ ...base, index: 0, data: new Uint8Array([1, 2]) })).toBeNull();
    expect(assembler.push({ ...base, index: 1, data: new Uint8Array([3]) })).toEqual({
      terminalId, sequence: "7", width: 80, height: 24, full: true, data: new Uint8Array([1, 2, 3]),
    });
    expect(() => assembler.push({ ...base, index: 1, data: new Uint8Array() })).toThrow("首片");
    assembler.reset();
    assembler.push({ ...base, index: 0, data: new Uint8Array([1]) });
    expect(() => assembler.push({ ...base, width: 81, index: 1, data: new Uint8Array([2]) })).toThrow("元数据");
  });

  test("binds command and close acknowledgements to their request", () => {
    const operationId = "op_0123456789abcdef";
    expect(parseTerminalCommandResult({
      operation_id: operationId, terminal_id: terminalId, accepted_seq: 4, duplicate: false,
    }, operationId, terminalId, 4)).toEqual({ operationId, terminalId, acceptedSequence: 4 });
    expect(() => parseTerminalCommandResult({
      operation_id: operationId, terminal_id: terminalId, accepted_seq: 3, duplicate: false,
    }, operationId, terminalId, 4)).toThrow(ProtocolError);
    expect(() => parseTerminalCommandResult({
      operation_id: operationId, terminal_id: terminalId, accepted_seq: 4, duplicate: true,
    }, operationId, terminalId, 4)).toThrow(ProtocolError);
    expect(() => parseTerminalCloseResult({
      operation_id: operationId, terminal_id: terminalId, closed: true,
    }, operationId, terminalId)).not.toThrow();
    expect(() => parseTerminalCloseResult({
      operation_id: operationId, terminal_id: terminalId, closed: false,
    }, operationId, terminalId)).toThrow(ProtocolError);
  });
});
