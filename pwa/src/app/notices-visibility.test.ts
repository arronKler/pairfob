import { describe, expect, test } from "bun:test";
import type { PairResult } from "../lib/protocol/client";
import { setCredential } from "../features/computers/catalog-store";
import { setPhase } from "../features/connection/connection-store";
import { goToScreen, setScreen } from "./navigation-store";
import {
  captureNoticeScope, clearNotice, showStatus, subscribeNotice, subscribeVisibleNotice, visibleNotice,
} from "./notices-store";
import { selectPane } from "../features/session/session-store";

/**
 * The visible notice is a function of five domains, so its subscription has to
 * cover five domains. These pin that contract and the raw-record meaning of
 * `subscribeNotice`, which must keep firing for the notice domain alone.
 */

const credential = (daemonId: string) => ({ daemonId }) as unknown as PairResult;

/** A known scope, so a test can move exactly one dimension of it. */
function arrange(): void {
  setPhase("live");
  setScreen("home");
  selectPane("pane_1");
  setCredential(credential("daemon_1"));
  clearNotice();
  showStatus("saved", true, captureNoticeScope());
}

describe("visible notice subscription", () => {
  test("a scoped notice is visible in its own scope", () => {
    arrange();
    expect(visibleNotice()?.text).toBe("saved");
  });

  test("moving the screen hides a scoped notice and notifies a visible-notice subscriber only", () => {
    arrange();
    let visible = 0;
    let raw = 0;
    const stopVisible = subscribeVisibleNotice(() => { visible += 1; });
    const stopRaw = subscribeNotice(() => { raw += 1; });
    // The notice record does not change; only the scope it was raised in does.
    setScreen("settings");
    expect(visibleNotice()).toBeNull();
    expect(visible).toBe(1);
    expect(raw).toBe(0);
    stopVisible();
    stopRaw();
  });

  test("every dimension of the scope can retire a notice on its own", () => {
    const moves: Array<[string, () => void]> = [
      ["phase", () => setPhase("connect")],
      ["screen", () => goToScreen("board")],
      ["daemon", () => setCredential(credential("daemon_2"))],
      ["pane", () => selectPane("pane_2")],
    ];
    for (const [name, move] of moves) {
      arrange();
      let visible = 0;
      const stop = subscribeVisibleNotice(() => { visible += 1; });
      move();
      expect(visibleNotice(), name).toBeNull();
      expect(visible, name).toBe(1);
      stop();
    }
  });

  test("writing the notice still notifies both subscriptions", () => {
    arrange();
    let visible = 0;
    let raw = 0;
    const stopVisible = subscribeVisibleNotice(() => { visible += 1; });
    const stopRaw = subscribeNotice(() => { raw += 1; });
    showStatus("second", true, captureNoticeScope());
    expect(visibleNotice()?.text).toBe("second");
    expect(raw).toBe(1);
    expect(visible).toBe(1);
    stopVisible();
    stopRaw();
  });

  test("an unscoped notice survives every scope move", () => {
    setPhase("live");
    setScreen("home");
    clearNotice();
    showStatus("global", true);
    const stop = subscribeVisibleNotice(() => {});
    setScreen("settings");
    selectPane("pane_9");
    setCredential(credential("daemon_9"));
    expect(visibleNotice()?.text).toBe("global");
    stop();
  });

  test("unsubscribing retires all five domains at once", () => {
    arrange();
    let visible = 0;
    const stop = subscribeVisibleNotice(() => { visible += 1; });
    stop();
    setScreen("settings");
    selectPane("pane_3");
    setPhase("connect");
    setCredential(credential("daemon_3"));
    showStatus("after", true);
    expect(visible).toBe(0);
    expect(visibleNotice()?.text).toBe("after");
  });
});
