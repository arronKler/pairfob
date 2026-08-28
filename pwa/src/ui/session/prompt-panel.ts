import { node } from "../../lib/dom";
import { chevron } from "../chrome";
import { liftAskLabel } from "../../lib/prompt";
import { render } from "../../paint";
import { selectedAgent, state } from "../../state";
import { answerPrompt } from "./keys";
import { type PaneModel } from "./model";

/**
 * Sits in the pane's flex column above the dock. An overlay would cover the
 * bottom of the buffer, which is exactly the diff or command being approved.
 */
export function promptPanel(model: PaneModel): HTMLElement | null {
  const block = model.block;
  if (block.kind !== "prompt-select" || state.termSelect) return null;
  const panel = node("section", "lift");
  panel.setAttribute("aria-label", "Agent 的提问");
  panel.append(node("p", "lift-tag", liftAskLabel(selectedAgent()?.agent)));
  if (block.question) panel.append(node("p", "q", block.question));
  block.options.forEach((option, index) => {
    const opt = node("button", "lift-opt");
    opt.type = "button";
    opt.append(node("span", "opt-n", option.n), node("span", "opt-label", option.label), chevron());
    opt.addEventListener("click", async () => {
      await answerPrompt(block, index);
      render();
    });
    panel.append(opt);
  });
  return panel;
}
