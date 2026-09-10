import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { publishPendingDomains } from "../../../app/domain-publication";
import {
  adoptChatDetailsOwner,
  chatDetailChoice,
  recordChatDetailChoice,
  resetChatDetails,
} from "../chat/details";
import { adoptSessionOwner, sessionOwner } from "../identity";
import { attachLiveSession } from "../../computers/catalog-store";
import { selectPane, setAgentChat } from "../session-store";
import { setScreen } from "../../../app/navigation-store";
import { AgentChatPane } from "../chat/agent-chat";
import { DeskShell } from "../../../app/layout/desk";
import { presentHerdView as prepareHerdView } from "../../../pages/home/herd-bridge";
import { SessionPane } from "./session-pane";

const live = () => ({ isConnected: () => true });
const noop = () => undefined;
const handlers = { onBack: noop, onMenu: noop, onSwitch: noop, onWorkspace: noop };

beforeEach(async () => {
  await resetBoardTestDOM();
  resetChatDetails();
  // Current live/pane already moved; render must not adopt them. Named owner
  // writes mirror the historical flat scene without the state facade.
  selectPane("p1");
  attachLiveSession(live() as never);
  setAgentChat(true);
  setScreen("pane");
  publishPendingDomains();
});

afterEach(() => {
  adoptSessionOwner({ session: null, paneId: "", viewIncarnation: 0 });
  resetChatDetails();
  attachLiveSession(null);
});

for (const [name, make] of [
  ["AgentChatPane", () => createElement(AgentChatPane, { includeBack: false, handlers })],
  ["SessionPane", () => createElement(SessionPane, {
    includeBack: false, handlers, scroll: { top: 0, left: 0, bottom: true },
    parts: { Terminal: () => null, RowBar: () => null, Dock: () => null },
  })],
  ["DeskShell", () => {
    // The compatibility DeskScreen wrapper is retired; the real desk shell
    // composes the same rail. The view bridge still consumes attention once
    // before the render-only attempt, as the wrapper's presentation did.
    prepareHerdView();
    return createElement(DeskShell, { deskPage: null }, createElement("div", null, "Child"));
  }],
] as const) {
  test(`${name} render-only attempt must not adopt global owner or erase stored details`, () => {
    const before = adoptSessionOwner({ session: live(), paneId: "committed-A", viewIncarnation: 91 });
    adoptChatDetailsOwner(before.key);
    expect(recordChatDetailChoice("remembered", true, before.key)).toBeTrue();
    let error: string | null = null;
    let markup = "";
    try {
      markup = renderToString(make());
    } catch (caught) {
      error = String(caught);
    }
    const after = sessionOwner();
    console.log("RENDER_PHASE_WRITE", JSON.stringify({
      component: name,
      beforeKey: before.key,
      afterKey: after.key,
      sameOwner: before === after,
      choiceAfter: chatDetailChoice("remembered"),
      serverError: error,
      markupLength: markup.length,
      domCommit: false,
    }));
    expect(before === after).toBeTrue();
    expect(chatDetailChoice("remembered")).toBeTrue();
  });
}
