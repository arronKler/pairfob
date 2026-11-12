import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setLang, t } from "../../../lib/i18n";
import { applySnapshot, liveAgents, resetDashboard } from "../../dashboard/catalog-store";
import { DEFAULT_LIST_GROUP } from "../../../lib/ranking";
import { resetHerdPresentationChoices, setListGroup } from "../../settings/preferences-store";
import { resetShownListOrder } from "../../dashboard/list-order";
import { SessionRuler } from "./session-ruler";

type Status = "blocked" | "working" | "idle";

function seed(panes: Array<{ id: string; label: string; status: Status }>): void {
  applySnapshot({
    workspaces: [{ workspace_id: "w", label: "project", cwd: "/repo" }],
    tabs: [{ tab_id: "t", workspace_id: "w", label: "main" }],
    panes: panes.map(({ id, label, status }) => ({
      pane_id: id, workspace_id: "w", tab_id: "t", cwd: "/repo",
      agent: "codex", agent_status: status, label,
    })),
  });
}

function paint(paneId: string): void {
  act(() => renderReact(
    <SessionRuler paneId={paneId} agents={liveAgents()} listGroup="flat" stale={false} />,
  ));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  // Beside the list, so the first-visit demonstration never arms in this suite.
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  setLang("zh");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  resetShownListOrder();
});

afterEach(() => {
  unmountReact();
  resetDashboard();
  resetShownListOrder();
  resetHerdPresentationChoices();
  setListGroup(DEFAULT_LIST_GROUP);
  happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
});

describe("the session ruler's ticks", () => {
  test("three rows draw three ticks, the open one current, with its position announced", () => {
    seed([
      { id: "p1", label: "alpha", status: "working" },
      { id: "p2", label: "beta", status: "blocked" },
      { id: "p3", label: "gamma", status: "idle" },
    ]);
    paint("p1");
    const ruler = appRoot().querySelector<HTMLElement>(".session-ruler");
    expect(ruler).not.toBeNull();
    const ticks = [...ruler!.querySelectorAll(".session-ruler-tick")];
    expect(ticks).toHaveLength(3);
    expect(ticks[0]!.classList.contains("is-current")).toBeTrue();
    expect(ticks[1]!.classList.contains("is-blocked")).toBeTrue();
    expect(ticks[2]!.classList.contains("is-current")).toBeFalse();
    expect(ruler!.getAttribute("role")).toBe("slider");
    expect(ruler!.getAttribute("aria-orientation")).toBe("horizontal");
    expect(ruler!.getAttribute("aria-valuemin")).toBe("1");
    expect(ruler!.getAttribute("aria-valuemax")).toBe("3");
    expect(ruler!.getAttribute("aria-valuenow")).toBe("1");
    expect(ruler!.getAttribute("aria-valuetext")).toBe(t("chrome.rulerValue", { n: "1", total: "3", title: "alpha" }));
    expect(ruler!.querySelector(".session-ruler-count")?.textContent).toBe("1 / 3");
  });

  test("another open row moves the current mark and the announced value", () => {
    seed([
      { id: "p1", label: "alpha", status: "working" },
      { id: "p2", label: "beta", status: "idle" },
      { id: "p3", label: "gamma", status: "idle" },
    ]);
    paint("p2");
    const ruler = appRoot().querySelector<HTMLElement>(".session-ruler")!;
    expect(ruler.getAttribute("aria-valuenow")).toBe("2");
    expect(ruler.querySelectorAll(".session-ruler-tick")[1]!.classList.contains("is-current")).toBeTrue();
  });

  test("one row, or an open pane that is not listed, draws no ruler", () => {
    seed([{ id: "p1", label: "alpha", status: "idle" }]);
    paint("p1");
    expect(appRoot().querySelector(".session-ruler")).toBeNull();

    unmountReact();
    act(() => seed([
      { id: "p1", label: "alpha", status: "idle" },
      { id: "p2", label: "beta", status: "idle" },
    ]));
    paint("gone");
    expect(appRoot().querySelector(".session-ruler")).toBeNull();
  });
});
