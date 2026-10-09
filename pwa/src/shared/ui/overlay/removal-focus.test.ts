import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { followRemoval } from "./removal-focus";

/**
 * Where the keyboard lands when a confirmed action takes its row out of the
 * list: the next row, the previous one for the last, the list's heading when
 * it is emptied, and never anywhere while focus is somewhere the reader chose.
 */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const by = (id: string) => document.getElementById(id)!;
let realObserver: unknown;

beforeEach(async () => {
  await resetTestDOM();
  realObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver;
  (globalThis as { MutationObserver?: unknown }).MutationObserver = happy.MutationObserver;
  document.body.insertAdjacentHTML("beforeend", `<div id="fixture">
    <nav id="rail">
    <header><button id="first">computer</button></header>
    <section id="group-a">
      <h3><button id="head-a">workspace a</button></h3>
      <div class="rows">
        <article id="row-1"><button id="main-1" data-trigger-of="p1">one</button><button id="more-1">more</button></article>
        <article id="row-2"><button id="main-2" data-trigger-of="p2">two</button><button id="more-2">more</button></article>
        <article id="row-3"><button id="main-3" data-trigger-of="p3">three</button><button id="more-3">more</button></article>
      </div>
    </section>
    <section id="group-b">
      <h3><button id="head-b">workspace b</button></h3>
      <div class="rows"><article id="row-4"><button id="main-4">four</button><button id="more-4">more</button></article></div>
    </section>
    </nav>
    <main><button id="header-more">session more</button></main>
  </div>`);
});
afterEach(() => {
  by("fixture").remove();
  (globalThis as { MutationObserver?: unknown }).MutationObserver = realObserver;
});

/** Confirm from `opener`, then the row leaves as the refreshed list drops it. */
async function closeRow(opener: string, row: string, options?: Parameters<typeof followRemoval>[1]): Promise<void> {
  by(opener).focus();
  followRemoval(by(opener), options);
  by(row).remove();
  // The browser leaves focus on nothing once its element has gone.
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
}

test("the next row takes the place of a closed one", async () => {
  await closeRow("more-1", "row-1");
  expectSameNode(document.activeElement, by("main-2"));
});

test("the last row's place goes to the one before it", async () => {
  await closeRow("more-3", "row-3");
  expectSameNode(document.activeElement, by("main-2"));
});

test("an emptied list hands focus to its heading; a whole group that left, to the group that took its place", async () => {
  await closeRow("more-4", "row-4");
  expectSameNode(document.activeElement, by("head-b"));
  by("more-1").focus();
  followRemoval(by("more-1"));
  by("group-a").remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  // The groups are the list now: the next one, entered at its first control.
  expectSameNode(document.activeElement, by("head-b"));
  by("head-b").focus();
  followRemoval(by("head-b"));
  by("group-b").remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  // The last group went too: what stands before the emptied list.
  expectSameNode(document.activeElement, by("first"));
});

test("a list whose other rows hold no control lands on its own heading, never on another section's control", async () => {
  by("fixture").innerHTML = `<main>
    <section id="computer"><h2>Computer</h2><div class="rows"><div class="row"><button id="update">Check for updates</button></div></div></section>
    <section id="devices"><h2 id="devices-title">Paired devices</h2>
      <div class="rows" id="device-rows">
        <div class="row" id="self"><span>This phone</span></div>
        <div class="row" id="other"><span>Tablet</span><button id="unpair">Unpair</button></div>
      </div><p>Manage others with <code>pairfob forget N</code>.</p></section>
    <section id="about"><h2>About</h2><button id="licenses">Licenses</button></section>
  </main>`;
  await closeRow("unpair", "other");
  // Not "Check for updates", which stands before the list but belongs to the computer.
  const heading = by("devices-title");
  expectSameNode(document.activeElement, heading);
  expect(heading.getAttribute("tabindex")).toBe("-1");
  expect(heading.hasAttribute("data-focus-landing")).toBeTrue();
  // The landing is for this once: when focus moves on the heading is plain text again.
  by("licenses").focus();
  expect(heading.hasAttribute("tabindex")).toBeFalse();
  expect(heading.hasAttribute("data-focus-landing")).toBeFalse();
});

test("a section with no heading lands on the list itself, and one with a control of its own still gets that", async () => {
  by("fixture").innerHTML = `<main>
    <section><button id="before">Before</button></section>
    <section id="bare"><div class="rows" id="bare-rows"><div class="row"><span>static</span></div>
      <div class="row" id="gone"><button id="act">Remove</button></div></div></section>
    <section id="owned"><button id="owner">Add device</button>
      <div class="rows"><div class="row" id="gone-2"><button id="act-2">Forget</button></div></div></section>
  </main>`;
  await closeRow("act", "gone");
  expectSameNode(document.activeElement, by("bare-rows"));
  await closeRow("act-2", "gone-2");
  // The control that owns the list, inside the list's own section.
  expectSameNode(document.activeElement, by("owner"));
});

test("with nothing left beside it focus goes home, else to the page's first control", async () => {
  by("header-more").focus();
  followRemoval(by("header-more"), { home: () => by("main-2") });
  by("header-more").parentElement!.remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  // The session column left: its neighbour is the list beside it, entered at its first control.
  expectSameNode(document.activeElement, by("first"));
  by("fixture").innerHTML = `<p>empty</p><button id="only">only</button>`;
  const only = by("only");
  const lone = document.createElement("button");
  document.body.append(lone);
  lone.focus();
  followRemoval(lone, { home: () => only });
  lone.remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  expectSameNode(document.activeElement, only);
});

test("the row may be named instead of the control that asked: the panel in the session header closes a row of the list", async () => {
  by("header-more").focus();
  followRemoval(null, { of: "p2" });
  // The session header goes with its session, then the list drops the row.
  by("header-more").remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  expectSameNode(document.activeElement, document.body);
  by("row-2").remove();
  await settle();
  expectSameNode(document.activeElement, by("main-3"));
});

test("a control that was only drawn again takes focus back itself, before any neighbour", async () => {
  const redraw = (): HTMLElement => {
    const again = document.createElement("button");
    again.id = "header-more";
    again.textContent = "session more";
    by("header-more").replaceWith(again);
    return again;
  };
  by("header-more").focus();
  followRemoval(by("header-more"), { redrawOnly: true });
  const again = redraw();
  await settle();
  expectSameNode(document.activeElement, again);
  // The same holds after a confirmed removal that left the opener's twin on the page.
  again.focus();
  followRemoval(again);
  const third = redraw();
  await settle();
  expectSameNode(document.activeElement, third);
});

test("an action that removed nothing guesses no neighbour when its control is simply gone", async () => {
  by("more-1").focus();
  followRemoval(by("more-1"), { redrawOnly: true, home: () => by("first") });
  by("row-1").remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  expectSameNode(document.activeElement, document.body);
});

test("focus the reader moved meanwhile is left where it is, and a row that stays moves nothing", async () => {
  by("more-1").focus();
  followRemoval(by("more-1"));
  by("head-b").focus();
  by("row-1").remove();
  await settle();
  expectSameNode(document.activeElement, by("head-b"));
  // A refused close: the row stays, and so does focus.
  by("more-2").focus();
  followRemoval(by("more-2"));
  by("row-3").remove();
  await settle();
  expectSameNode(document.activeElement, by("more-2"));
});

test("an open dialog keeps what it focused", async () => {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<button id="inside">ok</button>`;
  document.body.append(dialog);
  by("more-1").focus();
  followRemoval(by("more-1"));
  dialog.setAttribute("open", "");
  by("row-1").remove();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await settle();
  expectDifferentNode(document.activeElement, by("main-2"));
  dialog.remove();
});
