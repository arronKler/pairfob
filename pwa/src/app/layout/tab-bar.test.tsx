import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { setDesktopLive } from "../../features/remote-desktop/desktop-status";
import { setLang, t } from "../../lib/i18n";
import { MOTION_MS } from "../../shared/ui/dom/motion";
import { appRoot } from "../dom-root";
import { TabBar } from "./tab-bar";

describe("TabBar desktop live hiding", () => {
  beforeEach(async () => {
    await resetBoardTestDOM();
    setLang("zh");
    setDesktopLive(false);
  });

  afterEach(() => {
    setDesktopLive(false);
    act(() => unmountReact());
  });

  test("omits Desktop tab on home when host lacks view_desktop", () => {
    act(() => renderReact(<TabBar mode="home" />));
    expect([...appRoot().querySelectorAll(".tab-bar-label")].map((n) => n.textContent))
      .toEqual([t("tabs.sessions"), t("tabs.board"), t("tabs.settings")]);
  });

  test("stays visible on desktop route when not live (3rd slot), smoothly hides when live, and reappears on disconnect", async () => {
    act(() => renderReact(<TabBar mode="desktop" />));
    expect(appRoot().querySelector(".tab-bar")).not.toBeNull();
    expect(appRoot().querySelector(".tab-bar.is-leaving")).toBeNull();
    expect([...appRoot().querySelectorAll(".tab-bar-label")].map((n) => n.textContent))
      .toEqual([t("tabs.sessions"), t("tabs.board"), t("tabs.desktop"), t("tabs.settings")]);

    act(() => setDesktopLive(true));
    const leaving = appRoot().querySelector(".tab-bar");
    expect(leaving?.classList.contains("is-leaving")).toBeTrue();
    expect(leaving?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, MOTION_MS.element + 30));
    });
    expect(appRoot().querySelector(".tab-bar")).toBeNull();

    act(() => setDesktopLive(false));
    expect(appRoot().querySelector(".tab-bar")).not.toBeNull();
    expect(appRoot().querySelector(".tab-bar.is-leaving")).toBeNull();
  });
});
