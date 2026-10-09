import { expectSameNode } from "../../../test-support/node-identity";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { clearNotice, noticesStore, showError, showStatus, type Notice } from "../../app/notices-store";
import { noticeKeepsItsPlace, SessionAppNotice, SessionNotice } from "./session-notice";

const shell = await Bun.file(new URL("./guided/session-shell.scss", import.meta.url)).text();
const dock = await Bun.file(new URL("./guided/dock.scss", import.meta.url)).text();
const shared = await Bun.file(new URL("../../shared/ui/styles/notice.scss", import.meta.url)).text();

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`missing rule ${selector}`);
  return source.slice(start, source.indexOf("}", start));
}

/** A session reduced to what a notice can move: the header, the notice's place, the content. */
function Pane({ value, inPage }: { value: Notice | null; inPage?: boolean }) {
  return <div className="pane-root">
    <header className="chrome" />
    <SessionNotice value={value} inPage={inPage} />
    <div className="term-stage" />
  </div>;
}

const pane = () => appRoot().querySelector(".pane-root")!;
const notice = () => appRoot().querySelector<HTMLElement>("[data-app-notice]");
const anchor = () => appRoot().querySelector(".pane-root > .session-notice");

beforeEach(async () => {
  await resetTestDOM();
  clearNotice();
});

afterEach(() => {
  act(() => { unmountReact(); clearNotice(); });
});

describe("where a session puts its notice", () => {
  test("one that leaves by itself floats in an anchor between the header and the content", () => {
    for (const tone of ["status", "error"] as const) {
      act(() => renderReact(<Pane value={{ text: "仍在运行", tone }} />));
      expect(notice()?.parentElement?.className).toBe("session-notice");
      expect(anchor()?.previousElementSibling?.className).toBe("chrome");
      expect(anchor()?.nextElementSibling?.className).toBe("term-stage");
      expect(appRoot().querySelector(".pane-root > .notice")).toBeNull();
    }
  });

  test("assistive tech hears it as before: the live region is the notice itself", () => {
    act(() => renderReact(<Pane value={{ text: "已停止", tone: "status" }} />));
    expect([notice()?.getAttribute("role"), notice()?.getAttribute("aria-live"), notice()?.getAttribute("aria-atomic")])
      .toEqual(["status", "polite", "true"]);
    // The anchor is layout only; a role on it would swallow or double the announcement.
    expect([anchor()?.hasAttribute("role"), anchor()?.hasAttribute("aria-live"), anchor()?.hasAttribute("aria-hidden")])
      .toEqual([false, false, false]);
    act(() => renderReact(<Pane value={{ text: "未能停止", tone: "error" }} />));
    expect([notice()?.getAttribute("role"), notice()?.getAttribute("aria-live")]).toEqual(["alert", "assertive"]);
  });

  test("an error raised to stay keeps its place in the page", () => {
    act(() => renderReact(<Pane value={{ text: "发送未确认", tone: "error", persistent: true }} />));
    expect(notice()?.parentElement === pane()).toBeTrue();
    expect(notice()?.previousElementSibling?.className).toBe("chrome");
    expect(anchor()).toBeNull();
  });

  test("an operation in flight floats, so its result takes its place and nothing is laid out twice", () => {
    expect(noticeKeepsItsPlace({ text: "正在重命名…", tone: "status", persistent: true })).toBeFalse();
    act(() => renderReact(<Pane value={{ text: "正在重命名…", tone: "status", persistent: true }} />));
    const floating = anchor();
    const line = notice();
    expect(floating).not.toBeNull();
    act(() => renderReact(<Pane value={{ text: "已重命名", tone: "status" }} />));
    expectSameNode(anchor(), floating);
    expectSameNode(notice(), line);
    expect(notice()?.textContent).toBe("已重命名");
  });

  test("a note the session keeps on screen stays in the page whatever its tone", () => {
    act(() => renderReact(<Pane value={{ text: "没能完整读取", tone: "status" }} inPage />));
    expect(notice()?.parentElement === pane()).toBeTrue();
    expect(anchor()).toBeNull();
  });

  test("no notice leaves nothing behind", () => {
    act(() => renderReact(<Pane value={null} />));
    expect([...pane().children].map((child) => child.className)).toEqual(["chrome", "term-stage"]);
  });
});

describe("the notice domain tells the two kinds apart", () => {
  test("a timed notice carries no mark; one raised to stay is marked persistent", () => {
    showStatus("已停止");
    expect("persistent" in noticesStore.get().notice!).toBeFalse();
    showError("未能停止");
    expect("persistent" in noticesStore.get().notice!).toBeFalse();
    showError("发送未确认", true);
    expect(noticesStore.get().notice?.persistent).toBeTrue();
    showStatus("正在重命名…", true);
    expect(noticesStore.get().notice?.persistent).toBeTrue();
  });

  test("the connected notice floats a timed one, keeps a lasting error in the page, and never remounts its neighbours", () => {
    act(() => renderReact(<div className="pane-root"><header className="chrome" /><SessionAppNotice /><div className="term-stage" /></div>));
    const content = appRoot().querySelector(".term-stage");
    act(() => showStatus("仍在运行，可以强制停止"));
    expect(notice()?.parentElement?.className).toBe("session-notice");
    expectSameNode(appRoot().querySelector(".term-stage"), content);
    act(() => showError("发送未确认", true));
    expect(notice()?.parentElement === pane()).toBeTrue();
    expectSameNode(appRoot().querySelector(".term-stage"), content);
    act(clearNotice);
    expect(notice()).toBeNull();
    expect(anchor()).toBeNull();
    expectSameNode(appRoot().querySelector(".term-stage"), content);
  });
});

/** What a test DOM cannot lay out: the float takes no room and no press. */
describe("the floating notice's box", () => {
  test("its anchor is a flex item of no height, above the content, that no press can land on", () => {
    const float = rule(shell, ".session-notice");
    expect(float).toMatch(/flex:\s*none;/);
    expect(float).toMatch(/[\s;{]height:\s*0;/);
    expect(float).toMatch(/pointer-events:\s*none;/);
    expect(float).toMatch(/position:\s*relative;/);
    // Over the buffer and the transcript; the header is not under it, so it needs no more than their layer.
    expect(float).toMatch(/z-index:\s*3;/);
    // Nothing clips what hangs out of it, and nothing takes the notice out of the anchor's flow.
    expect(float).not.toMatch(/overflow/);
    expect(rule(shell, ".session-notice > .notice")).not.toMatch(/position|pointer-events:\s*auto/);
  });

  test("it hangs where the notice sat in the page: 8px under the header, 10px from the sides", () => {
    expect(rule(shell, ".session-notice > .notice")).toMatch(/margin:\s*8px 10px 0;/);
    expect(rule(shell, ".pane-root > .notice")).toMatch(/margin:\s*8px 10px 0;/);
  });

  test("it is opaque: each tone's own tint over a ground, with a soft shadow", () => {
    expect(shared).toMatch(/\$error-tint:\s*rgba\(214, 59, 49, 0\.12\);/);
    expect(shared).toMatch(/\$status-tint:\s*rgba\(110, 168, 254, 0\.1\);/);
    // The page's notices still paint the tint alone.
    expect(shared).toMatch(/\.notice-error \{\s*background:\s*\$error-tint;/);
    expect(shared).toMatch(/\.notice-status \{\s*background:\s*\$status-tint;/);
    expect(shell).toContain(".session-notice > .notice-error { background: linear-gradient(notice.$error-tint, notice.$error-tint), var(--surface); }");
    expect(shell).toContain(".session-notice > .notice-status { background: linear-gradient(notice.$status-tint, notice.$status-tint), var(--surface); }");
    expect(rule(shell, ".session-notice > .notice")).toMatch(/box-shadow:\s*var\(--shadow-1\);/);
  });

  test("it arrives with a short fade, and without one when motion is reduced", () => {
    expect(rule(shell, ".session-notice > .notice")).toMatch(/animation:\s*session-notice-in var\(--dur-2\) var\(--ease\);/);
    expect(shell).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.session-notice > \.notice \{ animation: none; \}/);
  });

  test("beside the list it stays on the guided column, as the notice in the page does", () => {
    const column = /\n  > \.notice,\n  > \.session-notice \{([^}]*)\}/.exec(dock);
    expect(column?.[1]).toMatch(/align-self:\s*center;/);
    expect(column?.[1]).toMatch(/max-width:\s*calc\(60rem - 2 \* var\(--space-4\)\);/);
    // The anchor has the column's width, so the notice in it adds no side margin of its own.
    expect(dock).toContain("  > .session-notice > .notice { margin-inline: 0; }");
  });
});
