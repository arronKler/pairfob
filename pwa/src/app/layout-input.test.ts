import { beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { batch } from "../shared/model/domain-store";
import { setPhase } from "../features/connection/connection-store";
import { attachLiveSession } from "../features/computers/catalog-store";
import { clearCreatedPane, markCreatedPane, resetObservationLifecycle, selectPane } from "../features/session/session-store";
import type { LiveSession } from "../lib/protocol/client";
import { setScreen } from "./navigation-store";
import { currentLayoutInput } from "./layout-input";

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  resetObservationLifecycle();
  selectPane("");
  batch(() => {
    setPhase("live");
    setScreen("pane");
    attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
  });
});

test("a created pane keeps the desk session column before its dashboard card lands", () => {
  selectPane("p1");
  expect(currentLayoutInput().hasSelectedPane).toBeFalse();
  markCreatedPane("p1");
  expect(currentLayoutInput().hasSelectedPane).toBeTrue();
  clearCreatedPane();
  expect(currentLayoutInput().hasSelectedPane).toBeFalse();
});
