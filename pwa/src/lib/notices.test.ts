import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./protocol/errors.ts";
import { FRIENDLY_ERROR, genericNotice, messageOf, noticeFor, sessionEventNotice } from "./notices.ts";
import { setLang } from "./i18n.ts";

const liveSrc = await Bun.file(new URL("../live.ts", import.meta.url)).text();
const operationSrc = await Bun.file(new URL("../live-operations.ts", import.meta.url)).text();
const stateSrc = await Bun.file(new URL("../state.ts", import.meta.url)).text();
const chromeSrc = await Bun.file(new URL("../ui/chrome.ts", import.meta.url)).text();

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const REQUIRED_PUBLIC_CODES = [
  "unpaired",
  "locator_required",
  "daemon_offline",
  "revoked",
  "herdr_offline",
  "unknown_outcome",
  "bad_grant",
  "grant_exhausted",
  "heartbeat_timeout",
  "wrong_protocol",
];

const NEXT_STEP = /刷新|请|打开|输入|pairfob|重新|稍后再试|回列表|看电脑|确认|换一|refresh|open|enter|retry|wait|list|computer/i;

const LEAK = /device_psk|reconnect_token|join_grant|pair_loc|\bjg_[0-9a-f]|Error\.Error|\bat Object\.|goroutine \d+|pairfob-v1\/sas/i;

function assertPublicNotice(text: string): void {
  expect(text.length).toBeGreaterThan(8);
  expect(text).toMatch(NEXT_STEP);
  expect(text).not.toMatch(LEAK);
  expect(text).not.toContain("stack");
  expect(text).not.toMatch(/\bs\s*=/);
}

describe("shipped user notices", () => {
  test("every mapped public code is a next step without secrets", () => {
    setLang("zh");
    const codes = Object.keys(FRIENDLY_ERROR);
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      const text = noticeFor(code);
      expect(text).toBe(FRIENDLY_ERROR[code]);
      assertPublicNotice(text);
    }
  });

  test("criterion-3 public codes are mapped, not generic", () => {
    for (const code of REQUIRED_PUBLIC_CODES) {
      const text = noticeFor(code);
      expect(text).not.toBe(genericNotice());
      assertPublicNotice(text);
    }
  });

  test("unknown codes fail closed and drop wire dumps", () => {
    expect(noticeFor("")).toBe(genericNotice());
    expect(noticeFor("not_a_real_code")).toBe(genericNotice());
    assertPublicNotice(genericNotice());
    const dumped = messageOf(new ProtocolError("not_a_real_code", "device_psk=deadbeef daemon websocket gone"));
    expect(dumped).toBe(genericNotice());
    expect(dumped).not.toContain("device_psk");
    expect(dumped).not.toContain("daemon websocket");
  });

  test("messageOf uses the shipped table and never Error.Error()", () => {
    expect(messageOf(new ProtocolError("daemon_offline", "daemon websocket gone"))).toBe(FRIENDLY_ERROR.daemon_offline);
    expect(FRIENDLY_ERROR.daemon_offline).toContain("合盖");
    expect(FRIENDLY_ERROR.daemon_offline).toContain("睡眠");
    expect(FRIENDLY_ERROR.daemon_offline).toContain("不用重新配对");
    expect(messageOf(new ProtocolError("revoked", "device revoked"))).toBe(FRIENDLY_ERROR.revoked);
    expect(messageOf(new Error("panic: runtime error\n    at Object.run"))).toBe(genericNotice());
    expect(messageOf("raw string dump")).toBe(genericNotice());
  });

  test("large reads are not mislabeled as unsent mutations", () => {
    const error = new ProtocolError("too_large", "response exceeds protocol limit");
    expect(messageOf(error)).toBe(FRIENDLY_ERROR.too_large);
    expect(messageOf(error, "read")).toContain("没能完整读取");
    expect(messageOf(error, "read")).not.toContain("没有发送");
  });

  test("live reconnect maps mux daemon_offline instead of ERROR.message", () => {
    for (const type of ["disconnected", "reconnecting"] as const) {
      for (const message of ["daemon websocket gone", "no daemon"]) {
        const text = sessionEventNotice({ type, code: "daemon_offline", message });
        expect(text).toBe(FRIENDLY_ERROR.daemon_offline);
        expect(text).not.toContain(message);
        assertPublicNotice(text);
      }
    }
    expect(sessionEventNotice({ type: "terminal", code: "daemon_offline", message: "daemon websocket gone" })).toBe(
      FRIENDLY_ERROR.daemon_offline,
    );
    expect(sessionEventNotice({ type: "reconnecting", message: "daemon websocket gone" })).toBe(FRIENDLY_ERROR.reconnecting);
    expect(sessionEventNotice({ type: "disconnected" })).toBe(FRIENDLY_ERROR.disconnected);
    expect(sessionEventNotice({ type: "disconnected", code: "heartbeat_timeout" })).toBe(FRIENDLY_ERROR.heartbeat_timeout);
    expect(sessionEventNotice({ type: "reconnecting", code: "heartbeat_timeout" })).toBe(FRIENDLY_ERROR.heartbeat_timeout);
    expect(sessionEventNotice({ type: "reconnecting", code: "not_a_real_code" })).toBe(FRIENDLY_ERROR.reconnecting);
    expect(sessionEventNotice({ type: "disconnected", code: "not_a_real_code" })).toBe(FRIENDLY_ERROR.disconnected);
    expect(messageOf(new ProtocolError("heartbeat_timeout", "relay 未及时响应心跳"))).toBe(FRIENDLY_ERROR.heartbeat_timeout);
    expect(messageOf(new ProtocolError("wrong_protocol", "relay 未协商 pairfob.v2"))).toBe(FRIENDLY_ERROR.wrong_protocol);
    expect(liveSrc).toContain("sessionEventNotice(event)");
    expect(liveSrc).not.toMatch(/showStatus\(event\.message/);
    expect(liveSrc).not.toMatch(/showError\(event\.message/);
  });

  test("herd operation success toasts dismiss; pending and reconnect stay", () => {
    expect(operationSrc).toContain("showStatus(pending, true, noticeScope)");
    expect(operationSrc).toContain("showStatus(success, false, noticeScope)");
    expect(liveSrc).toContain("showStatus(sessionEventNotice(event), true)");
  });

  test("prompt notices and refreshes stay with the pane that started the task", () => {
    const prompt = fnBody(operationSrc, "promptSelectedAgent");
    const operationStart = operationSrc.indexOf("async function runHerdOperation");
    const operationEnd = operationSrc.indexOf("async function selectCreatedPane", operationStart);
    const operation = operationSrc.slice(operationStart, operationEnd);
    const noteNode = fnBody(chromeSrc, "noteNode");
    expect(prompt).toContain("const noticeScope = captureNoticeScope()");
    expect(prompt).toContain("noticeScopeIsCurrent(noticeScope)");
    expect(prompt).toContain("noticeScope,");
    expect(operation).toContain("state.live === session && noticeScopeIsCurrent(noticeScope)");
    expect(operation).toContain("clearNoticeForScope(noticeScope)");
    expect(noteNode).toContain("visibleNotice()");
    expect(chromeSrc).toContain('element.setAttribute("role", value.tone === "error" ? "alert" : "status")');
    expect(chromeSrc).toContain('element.setAttribute("aria-live", value.tone === "error" ? "assertive" : "polite")');
    expect(chromeSrc).toContain('element.setAttribute("aria-atomic", "true")');
  });

  test("status toast timeout drops the live notice without remounting the pane", () => {
    const showStatus = fnBody(stateSrc, "showStatus");
    const clearNotice = fnBody(stateSrc, "clearNotice");
    const dropAppNotice = fnBody(stateSrc, "dropAppNotice");
    expect(stateSrc).toContain("STATUS_NOTICE_MS = 2800");
    expect(showStatus).toContain("dropAppNotice(text)");
    expect(showStatus).not.toContain("render(");
    expect(clearNotice).toContain("dropAppNotice()");
    expect(dropAppNotice).toContain('querySelectorAll("[data-app-notice]")');
    expect(chromeSrc).toContain('element.setAttribute("data-app-notice", "")');
  });
});
