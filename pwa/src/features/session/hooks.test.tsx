import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import "../../../test-support/boot-dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { setComposeDraft, setComposeLive } from "./compose-store";
import { resetDashboard, setRefreshBusy } from "../dashboard/catalog-store";
import { useAgents } from "../dashboard/hooks";
import { useAgentCard, useComposeLive, usePaneId } from "./hooks";
import { noteRelayRtt, setNetworkOnline } from "../connection/connection-store";
import { useConnectionContact, useNetworkOnline } from "../connection/hooks";
import { rememberPane, resetPreferences, setKeysExpanded, setListGroup, setQuickCommands, setTermFontPx } from "../settings/preferences-store";
import { useKeysExpanded, useListGroup, useQuickCommands } from "../settings/hooks";

/**
 * The narrow reads exist for one thing: a publish that does not change what a
 * screen draws must not repaint it. Each probe counts its own renders, and each
 * publish below is one a screen carries while the reader works.
 */
const renders = { agents: 0, card: 0, live: 0, pane: 0, listGroup: 0, keys: 0, commands: 0, online: 0, contact: 0 };
const reset = () => Object.assign(renders, { agents: 0, card: 0, live: 0, pane: 0, listGroup: 0, keys: 0, commands: 0, online: 0, contact: 0 });

function RowsProbe() {
  renders.agents += 1;
  return <p data-probe="agents">{useAgents().length}</p>;
}

function CardProbe({ paneId }: { paneId: string }) {
  renders.card += 1;
  return <p data-probe="card">{useAgentCard(paneId)?.status ?? ""}</p>;
}

function LiveProbe() {
  renders.live += 1;
  return <p data-probe="live">{String(useComposeLive())}</p>;
}

function PaneProbe() {
  renders.pane += 1;
  return <p data-probe="pane">{usePaneId()}</p>;
}

function GroupProbe() {
  renders.listGroup += 1;
  return <p data-probe="group">{useListGroup()}</p>;
}

function KeysProbe() {
  renders.keys += 1;
  return <p data-probe="keys">{String(useKeysExpanded())}</p>;
}

function CommandsProbe() {
  renders.commands += 1;
  return <p data-probe="commands">{String(useQuickCommands()?.length ?? 0)}</p>;
}

function OnlineProbe() {
  renders.online += 1;
  return <p data-probe="online">{String(useNetworkOnline())}</p>;
}

function ContactProbe() {
  renders.contact += 1;
  useConnectionContact();
  return <p data-probe="contact">header</p>;
}

function Probes() {
  return <>
    <RowsProbe />
    <CardProbe paneId="pane-a" />
    <LiveProbe />
    <PaneProbe />
    <GroupProbe />
    <KeysProbe />
    <CommandsProbe />
    <OnlineProbe />
    <ContactProbe />
  </>;
}

beforeEach(() => {
  reset();
  act(() => { resetDashboard(); resetPreferences(); noteRelayRtt(null); setNetworkOnline(true); });
  renderReact(<Probes />);
  reset();
});

afterEach(() => {
  unmountReact();
  act(() => { resetDashboard(); resetPreferences(); noteRelayRtt(null); setNetworkOnline(true); });
});

const text = (probe: string) => appRoot().querySelector(`[data-probe="${probe}"]`)?.textContent;

test("a refresh flag publish redraws no row and no card", () => {
  act(() => setRefreshBusy(true));
  act(() => setRefreshBusy(false));
  expect(renders).toEqual({ agents: 0, card: 0, live: 0, pane: 0, listGroup: 0, keys: 0, commands: 0, online: 0, contact: 0 });
  expect(text("agents")).toBe("0");
});

test("typing in the compose field redraws neither the mode switch nor the pane name", () => {
  act(() => setComposeDraft("半句草稿"));
  act(() => setComposeDraft("半句草稿，还有"));
  expect(renders).toEqual({ agents: 0, card: 0, live: 0, pane: 0, listGroup: 0, keys: 0, commands: 0, online: 0, contact: 0 });
  // The choice itself is drawn, so it is one repaint of the switch that reads it.
  act(() => setComposeLive(true));
  expect(renders.live).toBe(1);
  expect(text("live")).toBe("true");
});

test("the habit switch stays still while the draft and the focus move under it", () => {
  act(() => setComposeLive(true));
  reset();
  act(() => setComposeDraft("再写一句"));
  expect(renders.live).toBe(0);
});

test("a pinch, a tap and a command edit redraw no header and no key pad", () => {
  // The terminal font is written on every pinch move, and opening a pane
  // rewrites the activation order: both publish the preferences domain.
  act(() => setTermFontPx(18));
  act(() => setTermFontPx(19));
  act(() => rememberPane("pane-a"));
  act(() => setQuickCommands([]));
  expect({ listGroup: renders.listGroup, keys: renders.keys, online: renders.online, contact: renders.contact })
    .toEqual({ listGroup: 0, keys: 0, online: 0, contact: 0 });
  // What each control does draw still moves it, once.
  act(() => setListGroup("agent"));
  act(() => setKeysExpanded(true));
  expect(text("group")).toBe("agent");
  expect(text("keys")).toBe("true");
  expect(renders.keys).toBe(1);
});

test("a heartbeat redraws no header; reachability does", () => {
  act(() => noteRelayRtt(42));
  act(() => noteRelayRtt(43));
  expect({ online: renders.online, contact: renders.contact }).toEqual({ online: 0, contact: 0 });
  act(() => setNetworkOnline(false));
  expect(text("online")).toBe("false");
  expect(renders.contact).toBe(1);
});

