import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { paletteActions } from "../../features/command-palette/model/palette";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { applyRuntimeIdentity, setIdentityPending } from "../../features/connection/runtime-store";
import { createHerdActions } from "../../features/dashboard/actions";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { HerdScreen } from "../../features/dashboard/components/herd-screen";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { setListGroup } from "../../features/settings/preferences-store";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/client";
import { herdActionPorts, presentHerdView } from "../../pages/home/herd-bridge";
import { batch } from "../../shared/model/domain-store";
import { publishAllDomains } from "../domain-publication";
import { setScreen } from "../navigation-store";
import { DeskEmpty } from "./desk-empty";

/**
 * Every place that offers a new session answers alike, from one field of the
 * list's view model: the rail's create, the main column's, search and jump's
 * row, a workspace heading's + and the phone's button.
 */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = window.matchMedia;
let root: Root | null = null;
let container: HTMLElement;
let connected = true;
const actions = createHerdActions(herdActionPorts());

function seed(panes: string[]): void {
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "implementation" }],
    panes: panes.map((id) => ({ pane_id: id, workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: "idle", label: id })),
  } as never);
}

/** What each entry says for the herd as it stands: true where it can be pressed. */
function offered(variant: "rail" | "page"): Record<string, boolean | null> {
  publishAllDomains();
  const view = presentHerdView();
  act(() => root!.render(<>
    <HerdScreen view={view} actions={actions} variant={variant} />
    {variant === "rail" ? <DeskEmpty /> : null}
  </>));
  const enabled = (selector: string) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    return button ? !button.disabled : null;
  };
  const main = [...container.querySelectorAll<HTMLButtonElement>(".desk-empty-actions button")]
    .find((button) => button.textContent === t("empty.actionCreate"));
  const heading = [...container.querySelectorAll<HTMLButtonElement>(".group-tool")]
    .find((button) => button.getAttribute("aria-label") === t("list.newTabIn", { workspace: "pairfob" }));
  const palette = paletteActions(view).find((item) => item.action === "create");
  return {
    model: view.creatable,
    rail: enabled(".rail-create"),
    main: main ? !main.disabled : null,
    palette: palette ? !palette.disabled : null,
    heading: heading ? !heading.disabled : null,
    fab: enabled(".create-fab"),
  };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  connected = true;
  window.matchMedia = ((query: string) => query === FINE_POINTER
    ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, query)) as typeof window.matchMedia;
  batch(() => {
    setPhase("live");
    setScreen("home");
    setNetworkOnline(true);
    setIdentityPending(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => connected } as LiveSession);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true, create_tab: true }, []);
    setListGroup("space");
    resetDashboard();
    seed(["p1", "p2"]);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  window.matchMedia = realMatchMedia;
  batch(() => {
    attachLiveSession(null);
    setNetworkOnline(true);
    setIdentityPending(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    setListGroup("flat");
    resetDashboard();
  });
  publishAllDomains();
});

const all = (value: boolean) => ({ model: value, rail: value, main: value, palette: value, heading: value });

test("a computer that answers offers a new session everywhere; one that does not offers it nowhere", () => {
  expect(offered("rail")).toEqual({ ...all(true), fab: null });
  // Herdr did not answer, then is not running: the rows stay, and no entry invites a session.
  for (const runtimeKind of ["", "offline"]) {
    act(() => applyRuntimeIdentity({ herdHost: "", runtimeKind }));
    expect(offered("rail")).toEqual({ ...all(false), fab: null });
  }
  act(() => applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" }));
  act(() => setOperationBusy(true));
  expect(offered("rail")).toEqual({ ...all(false), fab: null });
  act(() => setOperationBusy(false));
  connected = false;
  expect(offered("rail")).toEqual({ ...all(false), fab: null });
  connected = true;
  act(() => setNetworkOnline(false));
  expect(offered("rail")).toEqual({ ...all(false), fab: null });
  act(() => setNetworkOnline(true));
  expect(offered("rail")).toEqual({ ...all(true), fab: null });
});

test("while the list is still being read the main column's held button is not contradicted by the rail or the palette", () => {
  act(() => batch(() => {
    resetDashboard();
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    setIdentityPending(true);
  }));
  // No rows yet, so no heading: the three entries the empty frame has.
  expect(offered("rail")).toEqual({ model: false, rail: false, main: false, palette: false, heading: null, fab: null });
  // The runtime answered; the first snapshot has not: still held.
  act(() => batch(() => { setIdentityPending(false); applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" }); }));
  expect(offered("rail")).toEqual({ model: false, rail: false, main: false, palette: false, heading: null, fab: null });
  act(() => seed(["p1"]));
  expect(offered("rail")).toEqual({ ...all(true), fab: null });
});

test("the phone's button and its headings read the same field", () => {
  expect(offered("page")).toMatchObject({ model: true, fab: true, heading: true, rail: null, main: null });
  act(() => applyRuntimeIdentity({ herdHost: "", runtimeKind: "offline" }));
  expect(offered("page")).toMatchObject({ model: false, fab: false, heading: false });
  act(() => applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" }));
  connected = false;
  expect(offered("page")).toMatchObject({ model: false, fab: false, heading: false });
});
