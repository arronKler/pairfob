import { afterEach, expect, test } from "bun:test";
import "../../../../test-support/boot-dom";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { applyCapabilities, clearCapabilities } from "../../operations/capabilities-store";
import { canEnterAgentChat } from "./agent-chat-controller";

afterEach(() => clearCapabilities());

test("a codex pane enters agent chat only when the runtime can bind a transcript", () => {
  // A terminal-core pane reports app=codex but has no AgentSession, so the
  // daemon advertises history:false even though the pane is readable.
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
  expect(canEnterAgentChat({ agent: "codex", hasAgent: true, historyAvailable: false })).toBeFalse();

  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true, prompt_agent: true }, []);
  expect(canEnterAgentChat({ agent: "codex", hasAgent: true, historyAvailable: true })).toBeTrue();
});
