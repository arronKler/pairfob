import { expectSameNode } from "../../../../test-support/node-identity";
import { resetBoardTestDOM, happy } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { followTrigger, liveTrigger, returnFocus } from "./trigger";

/** The control an overlay belongs to, found again after the shell redrew it. */
const made: Element[] = [];
function button(className: string, label: string, of?: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.className = className;
  node.setAttribute("aria-label", label);
  if (of !== undefined) node.setAttribute("data-trigger-of", of);
  document.body.append(node);
  made.push(node);
  return node;
}
const resize = () => window.dispatchEvent(new happy.Event("resize") as unknown as Event);

beforeEach(async () => { await resetBoardTestDOM(); });
// The reset keeps the body, so a case takes its own controls away.
afterEach(() => { for (const node of made.splice(0)) (node.closest("dialog") ?? node).remove(); });

test("a connected trigger is itself; a removed one is its only twin", () => {
  const more = button("icon-btn", "Session actions");
  expectSameNode(liveTrigger(more), more);
  more.remove();
  expect(liveTrigger(more)).toBeNull();
  const again = button("icon-btn", "Session actions");
  button("icon-btn", "Files");
  button("icon-btn is-on", "Session actions");
  expectSameNode(liveTrigger(more), again);
});

test("several alike, a nameless control, or a twin inside a dialog are not it", () => {
  const more = button("card-action", "More");
  more.remove();
  button("card-action", "More");
  button("card-action", "More");
  expect(liveTrigger(more)).toBeNull();

  const bare = button("icon-btn", "");
  bare.remove();
  button("icon-btn", "");
  expect(liveTrigger(bare)).toBeNull();

  const close = button("sheet-close", "Close");
  close.remove();
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.append(button("sheet-close", "Close"));
  expect(liveTrigger(close)).toBeNull();
});

test("focus follows a redrawn trigger only when the window was resized while the overlay was open", () => {
  const more = button("card-action", "More");
  const quiet = followTrigger(more);
  expectSameNode(quiet.live(), more);
  // The overlay's own action removed its row; the one row left is not that row.
  more.remove();
  const neighbour = button("card-action", "More");
  expect(quiet.live()).toBeNull();
  quiet.release();

  const moved = followTrigger(more);
  resize();
  expectSameNode(moved.live(), neighbour);
  moved.release();
  expect(followTrigger(null).live()).toBeNull();
});

test("one of several alike that says whose it is finds the control for the same object, whatever its name became", () => {
  const more = button("card-action is-more", "More", "p2");
  more.remove();
  button("card-action is-more", "More", "p1");
  const again = button("card-action is-more", "More", "p2");
  // The same row's other control, and a control that names no object, are not it.
  button("card-main", "Deploy · 3 min", "p2");
  button("card-action is-more", "More");
  expectSameNode(liveTrigger(more), again);

  const row = button("card-main", "Deploy · 3 min", "p9");
  row.remove();
  const later = button("card-main", "Deploy · 4 min", "p9");
  expectSameNode(liveTrigger(row), later);

  // Its object left the list: no other row's control stands in for it.
  const gone = button("card-action is-more", "More", "p7");
  gone.remove();
  expect(liveTrigger(gone)).toBeNull();
  // Drawn twice (a list and its copy) it is one of several again.
  button("card-action is-more", "More", "p2");
  expect(liveTrigger(more)).toBeNull();
});

test("a control that names its object is followed without a resize; a neighbour never is", () => {
  const more = button("card-action is-more", "More", "p2");
  const follow = followTrigger(more);
  more.remove();
  button("card-action is-more", "More", "p1");
  expect(follow.live()).toBeNull();
  // The list drew the row again (it moved to another group): the same session's control.
  const again = button("card-action is-more", "More", "p2");
  expectSameNode(follow.live(), again);
  follow.release();
});

test("focus goes home only when the trigger cannot take it and nothing else holds it", () => {
  const more = button("card-action", "More");
  const home = button("card-main", "Row");
  let asked = 0;
  const way = () => { asked += 1; return home; };
  returnFocus(more, way);
  expectSameNode(document.activeElement, more);
  expect(asked).toBe(0);

  // The row left the list while its menu was open.
  more.blur();
  returnFocus(null, way);
  expectSameNode(document.activeElement, home);
  // A control that will not take focus (folded away behind its row) is the same case.
  home.blur();
  const folded = button("card-action", "More");
  folded.focus = () => {};
  returnFocus(folded, way);
  expectSameNode(document.activeElement, home);
  expect(asked).toBe(2);

  // Something opened in between and focused its own control: it keeps it.
  const field = document.createElement("input");
  document.body.append(field);
  made.push(field);
  field.focus();
  returnFocus(null, way);
  expectSameNode(document.activeElement, field);
  expect(asked).toBe(2);
  // Without a home a missing trigger moves nothing.
  returnFocus(null);
  expectSameNode(document.activeElement, field);
});

test("a control that names its object is found a state class apart, and never taken for the other control of that object", () => {
  // A file row marks itself while its menu can open and clears the mark as it unmounts.
  const row = button("workspace-row-main workspace-file-actionable", "README.md", "README.md");
  row.remove();
  row.classList.remove("workspace-file-actionable");
  const again = button("workspace-row-main workspace-file-actionable", "README.md 1.5 KiB", "README.md");
  const more = button("workspace-row-more", "README.md actions", "README.md");
  button("workspace-row-main workspace-file-actionable", "package.json", "package.json");
  expectSameNode(liveTrigger(row), again);
  // "More" for the same file shares none of the row's classes: it is its own twin only.
  more.remove();
  expect(liveTrigger(more)).toBeNull();
  const moreAgain = button("workspace-row-more is-open", "README.md actions", "README.md");
  expectSameNode(liveTrigger(more), moreAgain);
  expectSameNode(liveTrigger(row), again);
  // Two rows for one object are still not guessed at.
  button("workspace-row-main", "README.md", "README.md");
  expect(liveTrigger(row)).toBeNull();
});
