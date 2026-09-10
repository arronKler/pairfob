import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./protocol/errors.ts";
import { FRIENDLY_ERROR, genericNotice, messageOf, noticeFor, sessionEventNotice } from "./notices.ts";
import { setLang } from "./i18n.ts";

const liveSrc = await Bun.file(new URL("../features/connection/session-events.ts", import.meta.url)).text();
const operationRunSrc = await Bun.file(new URL("../features/operations/run.ts", import.meta.url)).text();
const operationOwnerSrc = await Bun.file(new URL("../features/operations/owner.ts", import.meta.url)).text();
const operationSrc = await Bun.file(new URL("../features/operations/controller.ts", import.meta.url)).text();
const noticesSrc = await Bun.file(new URL("../app/notices-store.ts", import.meta.url)).text();
const noticeSrc = await Bun.file(new URL("../app/notice.tsx", import.meta.url)).text();
const feedbackSrc = await Bun.file(new URL("../shared/ui/primitives/feedback.tsx", import.meta.url)).text();
const mainSrc = await Bun.file(new URL("../app/bootstrap.ts", import.meta.url)).text();
const liveSettingsSrc = await Bun.file(new URL("../features/settings/actions.ts", import.meta.url)).text();
const pairingSrc = await Bun.file(new URL("../features/pairing/actions.ts", import.meta.url)).text();

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
    expect(noticeFor("bad_grant")).toBe(genericNotice());
    expect(noticeFor("grant_exhausted")).toBe(genericNotice());
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
    expect(operationRunSrc).toContain("showStatus(pending, true, noticeScope)");
    expect(operationRunSrc).toContain("showStatus(success, false, options.noticeScope ?? owner.scope)");
    expect(liveSrc).not.toMatch(/showStatus\(event\.message/);
    expect(liveSrc).not.toMatch(/showError\(event\.message/);
    expect(liveSrc).toContain("ports.showStatus(ports.sessionEventNotice(event), true)");
    expect(mainSrc).toContain('showStatus(t("net.offline"), true)');
    expect(mainSrc).toContain('showStatus(t("net.restored")');
    expect(mainSrc).not.toContain('showStatus(t("net.restored"), true)');
    expect(liveSettingsSrc).toContain("else clearNotice()");
    expect(pairingSrc).not.toContain("showStatus(messageOf(error), true)");
  });

  test("prompt notices and refreshes stay with the pane that started the task", () => {
    const prompt = fnBody(operationSrc, "promptSelectedAgent");
    expect(prompt).toContain("const noticeScope = captureNoticeScope()");
    expect(prompt).toContain("noticeScopeIsCurrent(noticeScope)");
    expect(prompt).toContain("noticeScope,");
    // The mutation runner revalidates the same owner contract (run.ts).
    expect(operationRunSrc).toContain("ownsOperationView(owner, ports, ports.currentLive(), ports.currentDaemonId())");
    expect(operationRunSrc).toContain("clearNoticeForScope(noticeScope)");
    const ownerCheck = fnBody(operationOwnerSrc, "ownsOperationView");
    expect(ownerCheck).toContain("ownsComputer(owner, current, daemonId)");
    expect(ownerCheck).toContain("owner.incarnation === ports.currentIncarnation()");
    expect(ownerCheck).toContain("noticeScopeIsCurrent(owner.scope)");
    const computerCheck = fnBody(operationOwnerSrc, "ownsComputer");
    expect(computerCheck).toContain("current === owner.session");
    expect(computerCheck).toContain("daemonId === owner.scope.daemonId");
    // The live session/daemon are the owner action-time defaults (function
    // signature), so a stale facade identity is not read inside the check.
    // Read the exact declaration span: from `function ownsComputer(` up to the
    // body's opening brace (the first `{` on the parameter list line).
    const ownsStart = operationOwnerSrc.indexOf("function ownsComputer(");
    expect(ownsStart).toBeGreaterThanOrEqual(0);
    const paramLineStart = operationOwnerSrc.indexOf("(", ownsStart);
    const bodyOpen = operationOwnerSrc.indexOf("{", paramLineStart);
    expect(bodyOpen).toBeGreaterThan(paramLineStart);
    const computerSignature = operationOwnerSrc.slice(ownsStart, bodyOpen);
    expect(computerSignature).toContain("current: LiveSession | null = liveSession()");
    expect(computerSignature).toContain("daemonId: string | null = currentDaemonId()");
    // The visible notice depends on the scope, which is read from four other
    // domains, so the subscription has to cover them and not the record alone.
    const noticeSubscription = fnBody(noticeSrc, "useAppNotice");
    expect(noticeSubscription).toContain("useSyncExternalStore(subscribeVisibleNotice, visibleNotice)");
    expect(feedbackSrc).toContain('role={value.tone === "error" ? "alert" : "status"}');
    expect(feedbackSrc).toContain('aria-live={value.tone === "error" ? "assertive" : "polite"}');
    expect(feedbackSrc).toContain('aria-atomic="true"');
  });

  test("status toast timeout drops the live notice without remounting the pane", () => {
    const showStatus = fnBody(noticesSrc, "showStatus");
    const showError = fnBody(noticesSrc, "showError");
    const schedule = fnBody(noticesSrc, "scheduleNoticeDismiss");
    const clearNotice = fnBody(noticesSrc, "clearNotice");
    expect(noticesSrc).toContain("STATUS_NOTICE_MS = 2800");
    expect(showStatus).toContain('scheduleNoticeDismiss(text, "status")');
    expect(showError).toContain('scheduleNoticeDismiss(text, "error")');
    expect(showError).toContain("const keep = typeof scopeOrPersist === \"boolean\" ? scopeOrPersist : persist");
    // The timeout and an explicit clear both drop the notice through the notice
    // domain's own publication, never through a page repaint.
    expect(schedule).toContain("write((record)");
    expect(schedule).toContain("record.notice = null");
    expect(schedule).not.toContain("render(");
    expect(showStatus).not.toContain("render(");
    expect(showError).toContain("write((record)");
    expect(clearNotice).toContain("write((record)");
    expect(clearNotice).toContain("record.notice = null");
    expect(feedbackSrc).toContain('data-app-notice={appNotice ? "" : undefined}');
  });
});
