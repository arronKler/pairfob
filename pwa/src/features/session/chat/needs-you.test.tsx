import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setLang, t } from "../../../lib/i18n";
import { ProtocolError } from "../../../lib/protocol/errors";
import type { LiveSession } from "../../../lib/protocol/client";
import { attachLiveSession } from "../../computers/catalog-store";
import { selectPane } from "../session-store";
import { NeedsYouCard } from "./needs-you";

const SCREEN = "  Would you like to run the following command?\n\n  $ rm -rf dist\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again (a)\n  3. No (esc)\n";
const HASH = "a".repeat(64);

type Sent = { keys: string[]; extra: unknown };
function session(sendKeys: (keys: string[], extra: unknown) => Promise<unknown>, screen = SCREEN) {
  const reads: number[] = [];
  attachLiveSession({
    paneRead: async (_pane: string, lines: number) => { reads.push(lines); return { text: screen, hash: HASH }; },
    sendKeys: (_pane: string, keys: string[], extra: unknown) => sendKeys(keys, extra),
  } as unknown as LiveSession);
  return reads;
}
const drain = () => act(async () => { for (let tick = 0; tick < 4; tick += 1) await Promise.resolve(); });
const button = (label: string) => [...appRoot().querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(label))!;

beforeEach(async () => { await resetTestDOM(); setLang("zh"); selectPane("p1"); });
afterEach(() => { act(unmountReact); attachLiveSession(null); selectPane(""); });

test("a numbered prompt is answered with the guarded keys for the chosen option", async () => {
  const sent: Sent[] = [];
  let answered = 0;
  const reads = session(async (keys, extra) => { sent.push({ keys, extra }); return { ok: true }; });
  act(() => renderReact(<NeedsYouCard ask={null} onAnswered={() => { answered++; }} />));
  await drain();
  expect(reads).toEqual([80]);
  expect(appRoot().querySelector(".needs-question")?.textContent).toBe("$ rm -rf dist");
  expect(appRoot().querySelector(".needs-screen")?.textContent).toBe("Would you like to run the following command?");
  expect(button(t("needs.send")).disabled).toBeTrue();
  act(() => button("Yes, and don't ask again").click());
  await act(async () => { button(t("needs.send")).click(); await Promise.resolve(); });
  await drain();
  expect(sent).toEqual([{ keys: ["down", "enter"], extra: { intent: "dialog", expected_prompt: "$ rm -rf dist", expected_signature: HASH } }]);
  expect(answered).toBe(1);
  expect(appRoot().textContent).toContain(t("needs.sent"));
});

test("a changed prompt is read again and never resent on its own", async () => {
  let calls = 0;
  const reads = session(async () => { calls += 1; throw new ProtocolError("stale_prompt", "signature mismatch"); });
  act(() => renderReact(<NeedsYouCard ask={null} />));
  await drain();
  act(() => button("Yes, proceed").click());
  await act(async () => { button(t("needs.send")).click(); await Promise.resolve(); });
  await drain();
  expect(calls).toBe(1);
  expect(reads).toEqual([80, 80]);
  expect(appRoot().querySelector('[role="alert"]')?.textContent).toBe(t("needs.stale"));
  expect(appRoot().querySelector(".needs-option.is-chosen")).toBeNull();
  expect(button(t("needs.send")).disabled).toBeTrue();
});

test("a prompt that is not a list shows the screen excerpt and only the terminal action", async () => {
  session(async () => ({ ok: true }), "Some output\n\nTrust the files in this folder? (y/n)\n");
  let exits = 0;
  act(() => renderReact(<NeedsYouCard ask={{ verb: t("needs.run"), object: "make" }} onTerminal={() => { exits++; }} />));
  await drain();
  expect(appRoot().querySelector(".needs-screen")?.textContent).toBe("Some output\nTrust the files in this folder? (y/n)");
  expect(appRoot().querySelector(".needs-send")).toBeNull();
  act(() => appRoot().querySelector<HTMLButtonElement>(".needs-go")!.click());
  expect(exits).toBe(1);
});

test("after an answer the same screen stays locked; a new prompt opens again", async () => {
  let screen = SCREEN;
  let hash = HASH;
  let sends = 0;
  attachLiveSession({
    paneRead: async () => ({ text: screen, hash }),
    sendKeys: async () => { sends += 1; return { ok: true }; },
  } as unknown as LiveSession);
  act(() => renderReact(<NeedsYouCard ask={null} />));
  await drain();
  act(() => button("Yes, proceed").click());
  await act(async () => { button(t("needs.send")).click(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)); });
  expect(appRoot().textContent).toContain(t("needs.sent"));
  expect(button(t("needs.send")).disabled).toBeTrue();
  screen = SCREEN.replace("rm -rf dist", "git push --force");
  hash = "b".repeat(64);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2600)); });
  expect(appRoot().querySelector(".needs-question")?.textContent).toBe("$ git push --force");
  expect(appRoot().textContent).not.toContain(t("needs.sent"));
  expect(sends).toBe(1);
});

test("the screen's own prompt leads even when the transcript has a pending tool", async () => {
  session(async () => ({ ok: true }));
  act(() => renderReact(<NeedsYouCard ask={{ verb: t("needs.tool", { name: "Task" }), object: "Investigate build" }} />));
  await drain();
  expect(appRoot().querySelector(".needs-screen")?.textContent).toBe("Would you like to run the following command?");
  expect(appRoot().querySelector(".needs-question")?.textContent).toBe("$ rm -rf dist");
  expect(appRoot().querySelector(".needs-ask")).toBeNull();
});

test("a re-read while an answer is in flight cannot re-open the choice", async () => {
  let finish!: () => void;
  let sends = 0;
  const reads = session(() => { sends += 1; return new Promise((resolve) => { finish = () => resolve({ ok: true }); }); });
  act(() => renderReact(<NeedsYouCard ask={null} />));
  await drain();
  act(() => button("Yes, proceed").click());
  await act(async () => { button(t("needs.send")).click(); await Promise.resolve(); });
  expect(button(t("needs.sending")).disabled).toBeTrue();
  expect(appRoot().querySelector<HTMLFieldSetElement>(".needs-dialog")!.disabled).toBeTrue();
  expect(reads).toEqual([80]);
  await act(async () => { finish(); await Promise.resolve(); });
  await drain();
  expect(sends).toBe(1);
});

test("a prompt that keeps changing points to the terminal after the second refusal", async () => {
  session(async () => { throw new ProtocolError("stale_prompt", "signature mismatch"); });
  act(() => renderReact(<NeedsYouCard ask={null} />));
  await drain();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    act(() => button("Yes, proceed").click());
    await act(async () => { button(t("needs.send")).click(); await Promise.resolve(); });
    await drain();
  }
  expect(appRoot().querySelector('[role="alert"]')?.textContent).toBe(t("needs.unstable"));
});

/** The fixture DOM has no layout: the card is 40px while it reads and 200px once the options show. */
async function growInside(scrollTop: number): Promise<HTMLElement> {
  session(async () => ({ ok: true }));
  const rect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const height = this.classList.contains("needs-card") ? (this.querySelector(".needs-option") ? 200 : 40) : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON() {} } as DOMRect;
  };
  try {
    act(() => renderReact(<div className="agent-stream"><NeedsYouCard ask={null} /></div>));
    const stream = appRoot().querySelector<HTMLElement>(".agent-stream")!;
    // 600px of transcript in a 300px scrollport; the grown card makes it 760px.
    Object.defineProperties(stream, {
      scrollHeight: { configurable: true, get: () => (stream.querySelector(".needs-option") ? 760 : 600) },
      clientHeight: { configurable: true, value: 300 },
    });
    stream.scrollTop = scrollTop;
    await drain();
    return stream;
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = rect;
  }
}

test("a reader at the latest turn stays there when the card grows with its choices", async () => {
  expect((await growInside(300)).scrollTop).toBe(760);
});

test("a reader further up is not moved when the card grows", async () => {
  expect((await growInside(120)).scrollTop).toBe(120);
});
