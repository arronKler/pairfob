import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { connectFailure, setConnectFailure, setPhase } from "../connection/connection-store";
import {
  pairCodeDraft, pairErrorTarget, pairFailedStep, pairManualOpen, pairingStore, resetPairingInput, setPairCodeDraft,
  setPairFailure, setPairManualOpen,
} from "./form-store";
import { clearNotice, showError, visibleNotice } from "../../app/notices-store";
import { setPairCode } from "./actions";

/**
 * Editing the code after a failure.
 *
 * A failure belongs to the code that was tried. Once the reader changes the
 * draft, the field mark, the failed step and the notice carrying the reason
 * are stale and go together; anything that is not the form's own failure
 * stays where it is.
 */

beforeEach(async () => {
  await resetBoardTestDOM();
  act(() => {
    setPhase("connect");
    resetPairingInput();
    clearNotice();
    setConnectFailure("");
  });
});

afterEach(() => {
  act(() => {
    resetPairingInput();
    clearNotice();
    setConnectFailure("");
    setPhase("boot");
  });
});

function failed(target: "code" | null, step: "code" | "channel" | "verify", text: string): void {
  act(() => {
    setPairCodeDraft("ABCD");
    setPairManualOpen(true);
    setPairFailure(target, step);
    showError(text, true);
  });
}

test("a changed code drops the rejected code's field error and its notice", () => {
  failed("code", "code", "配对码还没输完整");
  let publications = 0;
  const stop = pairingStore.subscribe(() => { publications += 1; });
  act(() => setPairCode("ABCD-E"));
  stop();
  expect(pairCodeDraft()).toBe("ABCD-E");
  expect(pairErrorTarget()).toBeNull();
  expect(pairFailedStep()).toBeNull();
  expect(visibleNotice()).toBeNull();
  // The sheet the error opened stays open: the reader is typing in it.
  expect(pairManualOpen()).toBeTrue();
  // Draft and failure change as one publication, never a frame with both.
  expect(publications).toBe(1);
});

test("clearing the field counts as a change", () => {
  failed("code", "code", "配对码不对");
  act(() => setPairCode(""));
  expect(pairErrorTarget()).toBeNull();
  expect(visibleNotice()).toBeNull();
});

test("a failed handshake step goes with the code it was tried with", () => {
  failed(null, "verify", "电脑上没有确认。");
  act(() => setPairCode("WXYZ"));
  expect(pairFailedStep()).toBeNull();
  expect(visibleNotice()).toBeNull();
});

test("an input that leaves the draft as it was keeps the error", () => {
  failed("code", "code", "配对码还没输完整");
  act(() => setPairCode("ABCD"));
  expect(pairErrorTarget()).toBe("code");
  expect(pairFailedStep()).toBe("code");
  expect(visibleNotice()?.text).toBe("配对码还没输完整");
});

test("typing with no pairing failure leaves a notice the form did not raise", () => {
  act(() => showError("这台设备已被移除。", true));
  act(() => setPairCode("A"));
  expect(pairCodeDraft()).toBe("A");
  expect(visibleNotice()?.text).toBe("这台设备已被移除。");
});

test("the connection's failure reason is not the field's to clear", () => {
  act(() => setConnectFailure("daemon_offline"));
  failed("code", "code", "配对码不对");
  act(() => setPairCode("ABCD-EFGH"));
  expect(pairErrorTarget()).toBeNull();
  expect(connectFailure()).toBe("daemon_offline");
});
