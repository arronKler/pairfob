import { afterEach, describe, expect, test } from "bun:test";
import "../../test-support/boot-dom";

const { captureNoticeScope, clearNotice, clearNoticeForScope, disposeNoticeLifecycle, noticesStore, showError,
  showStatus, STATUS_NOTICE_MS, subscribeNotice, subscribeVisibleNotice, visibleNotice } = await import("./notices-store");
const { setCredential } = await import("../features/computers/catalog-store");
const { preferencesStore } = await import("../features/settings/preferences-store");
const { setScreen, currentScreen } = await import("./navigation-store");
const { selectPane, openPaneId } = await import("../features/session/session-store");
const { setPhase, phase } = await import("../features/connection/connection-store");

const restore = {
  screen: currentScreen(),
  paneId: openPaneId(),
  phase: phase(),
};

afterEach(() => {
  disposeNoticeLifecycle();
  clearNotice();
  setScreen(restore.screen);
  selectPane(restore.paneId);
  setPhase(restore.phase);
});

describe("notice domain", () => {
  test("a toast publishes on its own, without a page commit", () => {
    let publishes = 0;
    const release = subscribeNotice(() => { publishes += 1; });

    showError("配对失败");
    expect(publishes).toBe(1);
    expect(noticesStore.get().notice?.text).toBe("配对失败");
    expect(noticesStore.get().notice?.tone).toBe("error");
    expect(visibleNotice()?.text).toBe("配对失败");
    expect(noticesStore.isDirty()).toBeFalse();

    showStatus("已刷新", true);
    expect(publishes).toBe(2);
    expect(visibleNotice()?.tone).toBe("status");
    release();
  });

  test("a scoped notice stops being visible when the reader leaves its scope", () => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    const scope = captureNoticeScope();
    showStatus("已发送", true, scope);
    expect(visibleNotice()?.text).toBe("已发送");

    // The notice is still stored; it is simply not shown on another pane.
    selectPane("p2");
    expect(noticesStore.get().notice?.text).toBe("已发送");
    expect(visibleNotice()).toBeNull();

    selectPane("p1");
    expect(visibleNotice()?.text).toBe("已发送");

    setScreen("home");
    expect(visibleNotice()).toBeNull();
  });

  test("an unscoped notice follows the reader and only an explicit clear drops it", () => {
    showStatus("网络已恢复", true);
    setScreen("settings");
    expect(visibleNotice()?.text).toBe("网络已恢复");

    // A scoped clear never drops a notice that was raised for the whole app.
    clearNoticeForScope(captureNoticeScope());
    expect(noticesStore.get().notice?.text).toBe("网络已恢复");

    const scoped = captureNoticeScope();
    showStatus("仅本窗格", true, scoped);
    clearNoticeForScope({ phase: "live", screen: "pane", daemonId: null, paneId: "other" });
    expect(noticesStore.get().notice?.text).toBe("仅本窗格");
    clearNoticeForScope(scoped);
    expect(noticesStore.get().notice).toBeNull();
    expect(visibleNotice()).toBeNull();
  });

  test("the dismiss timeout is a domain constant, not a repaint", () => {
    expect(STATUS_NOTICE_MS).toBe(2800);
  });
});

describe("visible-notice subscription", () => {
  test("it hears the scope domains that can hide the notice", () => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    let heard = 0;
    const release = subscribeVisibleNotice(() => { heard += 1; });

    // Raising a scoped notice changes what is visible.
    showStatus("已发送", true, captureNoticeScope());
    expect(heard).toBe(1);
    expect(visibleNotice()?.text).toBe("已发送");

    // Leaving the pane hides it, so the subscriber has to hear that too.
    selectPane("p2");
    expect(heard).toBe(2);
    expect(visibleNotice()).toBeNull();

    // Another screen, another computer and another phase each change visibility.
    selectPane("p1");
    expect(heard).toBe(3);
    setScreen("home");
    expect(heard).toBe(4);
    setScreen("pane");
    expect(heard).toBe(5);
    setCredential({ daemonId: "d_other", deviceId: "dev_other" } as never);
    expect(heard).toBe(6);
    expect(visibleNotice()).toBeNull();
    // Back to the computer the notice was raised on: visible again.
    setCredential(null);
    expect(heard).toBe(7);
    expect(visibleNotice()?.text).toBe("已发送");
    setPhase("connect");
    expect(heard).toBe(8);
    expect(visibleNotice()).toBeNull();
    release();
  });

  test("it stays quiet when the visible notice does not change", () => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    showStatus("网络已恢复", true);
    let heard = 0;
    const release = subscribeVisibleNotice(() => { heard += 1; });

    // An unscoped notice is visible everywhere: moving around does not change it.
    selectPane("p2");
    setScreen("settings");
    setPhase("resuming");
    expect(heard).toBe(0);
    expect(visibleNotice()?.text).toBe("网络已恢复");

    // An unrelated domain publishing is not this subscriber's business.
    preferencesStore.publish();
    expect(heard).toBe(0);

    clearNotice();
    expect(heard).toBe(1);
    expect(visibleNotice()).toBeNull();
    release();
  });

  test("the raw notice subscription keeps its own semantics", () => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    let raw = 0;
    const release = subscribeNotice(() => { raw += 1; });
    const scope = captureNoticeScope();

    showStatus("已发送", true, scope);
    expect(raw).toBe(1);
    // A scope change does not publish the notice domain at all.
    selectPane("p2");
    expect(raw).toBe(1);
    expect(noticesStore.get().notice?.text).toBe("已发送");
    // Clearing publishes, even though the notice was already out of scope.
    clearNotice();
    expect(raw).toBe(2);
    release();
  });
});
