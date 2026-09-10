import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;

const {
  ECHO_ROLLBACK_MS,
  ECHO_TIMEOUT_MS,
  echoGhost,
  isPredictable,
  predictKeys,
  predictText,
  resetEcho,
  setEchoObserver,
  settleEcho,
  subscribeEcho,
} = await import("./echo.ts");

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

afterEach(() => resetEcho());

describe("what may be predicted at all", () => {
  test("printable characters are predictable; TUI control keys never are", () => {
    expect(isPredictable("a")).toBeTrue();
    expect(isPredictable("Z")).toBeTrue();
    expect(isPredictable(" ")).toBeTrue();
    for (const key of ["enter", "esc", "tab", "up", "down", "left", "right", "backspace", "ctrl+c", "ctrl+z"]) {
      expect(isPredictable(key)).toBeFalse();
    }
  });

  test("a control key drops whatever was predicted before it", () => {
    predictKeys("p1", ["h", "i"], "h0");
    expect(echoGhost("p1").text).toBe("hi");
    predictKeys("p1", ["enter"], "h0");
    expect(echoGhost("p1").text).toBe("");
  });

  test("backspace pops a predicted character but never guesses at the runtime's own", () => {
    predictKeys("p1", ["a", "b"], "h0");
    predictKeys("p1", ["backspace"], "h0");
    expect(echoGhost("p1").text).toBe("a");
    predictKeys("p1", ["backspace"], "h0");
    predictKeys("p1", ["backspace"], "h0");
    expect(echoGhost("p1").text).toBe("");
  });

  test("a prediction belongs to the pane it was typed in", () => {
    predictKeys("p1", ["x"], "h0");
    expect(echoGhost("p2").text).toBe("");
  });
});

describe("predict then confirm", () => {
  test("a snapshot that shows the typed text clears the ghost silently", () => {
    predictKeys("p1", ["l", "s"], "h0");
    expect(echoGhost("p1")).toEqual({ text: "ls", rollback: false });
    const contradicted = settleEcho("p1", ["$ ls"], "h1");
    expect(contradicted).toBeFalse();
    expect(echoGhost("p1")).toEqual({ text: "", rollback: false });
  });

  test("an unchanged snapshot resolves nothing and keeps the prediction visible", () => {
    predictKeys("p1", ["l", "s"], "h0");
    expect(settleEcho("p1", ["$ "], "h0")).toBeFalse();
    expect(echoGhost("p1").text).toBe("ls");
  });
});

describe("predict then roll back", () => {
  test("a snapshot that disagrees fades the undone characters instead of jumping", async () => {
    predictKeys("p1", ["l", "s"], "h0");
    expect(settleEcho("p1", ["$ something else"], "h1")).toBeTrue();
    expect(echoGhost("p1")).toEqual({ text: "ls", rollback: true });
    await wait(ECHO_ROLLBACK_MS + 60);
    expect(echoGhost("p1")).toEqual({ text: "", rollback: false });
  });

  test("the runtime's own text is what remains; nothing is resent", () => {
    predictKeys("p1", ["q"], "h0");
    settleEcho("p1", ["prompt>"], "h1");
    // Only the fading copy is left, and it is display state, not input.
    expect(echoGhost("p1").rollback).toBeTrue();
    settleEcho("p1", ["prompt>"], "h2");
    expect(echoGhost("p1").text).toBe("q");
  });
});

describe("predict then time out", () => {
  test("a prediction no read ever covered disappears rather than passing for truth", async () => {
    predictText("p1", "hello", "h0");
    expect(echoGhost("p1").text).toBe("hello");
    await wait(ECHO_TIMEOUT_MS + 120);
    expect(echoGhost("p1")).toEqual({ text: "", rollback: false });
  });

  test("each new character extends the window rather than starting a second one", async () => {
    predictText("p1", "ab", "h0");
    await wait(ECHO_TIMEOUT_MS * 0.7);
    predictText("p1", "c", "h0");
    await wait(ECHO_TIMEOUT_MS * 0.5);
    expect(echoGhost("p1").text).toBe("abc");
    await wait(ECHO_TIMEOUT_MS);
    expect(echoGhost("p1").text).toBe("");
  });
});

describe("the echo is display only", () => {
  test("streamed text stops predicting at the first control character", () => {
    predictText("p1", "ok\n", "h0");
    expect(echoGhost("p1").text).toBe("");
  });

  test("nothing in the module can send, replay or retry", async () => {
    const source = await Bun.file(new URL("./echo.ts", import.meta.url)).text();
    for (const forbidden of ["sendKeys", "sendText", "operation_id", "requestPaneRefresh", "session"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("subscribeEcho fans out without replacing setEchoObserver", () => {
    const legacy: number[] = [];
    const extra: number[] = [];
    setEchoObserver(() => legacy.push(1));
    const stop = subscribeEcho(() => extra.push(1));
    predictKeys("p1", ["x"], "h0");
    expect(legacy).toEqual([1]);
    expect(extra).toEqual([1]);
    setEchoObserver(null);
    predictKeys("p1", ["y"], "h0");
    expect(legacy).toEqual([1]);
    expect(extra).toEqual([1, 1]);
    stop();
    predictKeys("p1", ["z"], "h0");
    expect(extra).toEqual([1, 1]);
  });
});
