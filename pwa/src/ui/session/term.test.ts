import { describe, expect, test } from "bun:test";

const termSource = await Bun.file(new URL("./term.ts", import.meta.url)).text();
const keysSource = await Bun.file(new URL("./keys.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../../live.ts", import.meta.url)).text();

function body(name: string): string {
  const start = termSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const open = termSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < termSource.length; i += 1) {
    if (termSource[i] === "{") depth += 1;
    if (termSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return termSource.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

describe("terminal rows stay faithful to the live TUI", () => {
  test("the tap handler focuses input and never interprets terminal text", () => {
    const tap = body("bindTap");
    expect(tap).toContain("focusCompose()");
    expect(tap).toContain("HOLD_MS");
    expect(tap).not.toContain("answerPrompt");
    expect(tap).not.toContain("prompt-select");
  });

  test("a short tap types; a long press opens the row bar", () => {
    const tap = body("bindTap");
    expect(tap).toContain("focusCompose()");
    expect(tap).toContain("onRow(index)");
    expect(tap).toContain('"scroll"');
    expect(tap).toContain("panned");
  });

  test("the patch path that delivers the dialog does not repaint the pane", () => {
    expect(liveSource).toContain("patchSessionScreen()");
    expect(termSource).toContain("export function fillTerm");
  });

  test("paint mounts every screen row without inventing buttons or options", () => {
    const fill = body("fillTerm");
    expect(fill).toContain("lineRow(line)");
    expect(fill).not.toContain('setAttribute("role", "button")');
    expect(fill).not.toContain("term-option");
    expect(termSource).not.toContain("answerPrompt");
    expect(termSource).not.toContain("prompt-select");
  });

  test("paint drops computer-window padding before rows are mounted", () => {
    expect(termSource).toContain("paintLines(model.lines)");
  });

  test("rows share a max-content canvas so short TUI bars match long lines", () => {
    expect(termSource).toContain('querySelector(".term-inner")');
    expect(termSource).toContain("termInner(term).replaceChildren(frag)");
  });

  test("the live buffer is only the current viewport", () => {
    expect(termSource).not.toContain("term-more");
    expect(termSource).not.toContain("term-back");
    expect(termSource).not.toContain("fetchTerminalHistory");
    expect(termSource).not.toContain("revealOlder");
    expect(termSource).not.toContain("olderThanLive");
  });

  test("TUI wheel uses TerminalScroll while page buttons keep CSI", () => {
    expect(termSource).toContain("sendGuidedTuiScroll");
    expect(termSource).not.toContain('"pageup"');
    expect(termSource).not.toContain('"pagedown"');
    expect(termSource).toContain('source === "page_key"');
    expect(termSource).toContain("sendPage");
    expect(termSource).toContain("guidedScrollController.scroll");
    expect(termSource).toContain("direction, lines");
    expect(keysSource).toContain("\\u001b[5~");
    expect(keysSource).toContain("session.sendText");
    expect(termSource).toContain("scrollRail(");
    expect(termSource).toContain("sendGuidedTuiScroll(direction, lines, source)");
    expect(termSource).toContain("capturePan: guidedCapturePan");
  });
});

describe("the buffer is a live PTY surface, not a fitted screenshot", () => {
  test("session paint does not auto-shrink the grid to the phone width", async () => {
    const view = await Bun.file(new URL("./view.ts", import.meta.url)).text();
    expect(view).not.toContain("syncTermWidthFit");
    expect(termSource).not.toContain("syncTermWidthFit");
  });
});

describe("terminal scroll restoration", () => {
  test("applies scroll after replaceChildren and again on the next frame", () => {
    expect(termSource).toContain("export function restoreTermScroll");
    expect(termSource).toContain("requestAnimationFrame(apply)");
  });
});
