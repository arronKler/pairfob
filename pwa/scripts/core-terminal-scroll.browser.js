async page => {
  const browser = page.context().browser();
  const origin = new URL(page.url()).origin;
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  for (const profile of [
    { name: "phone", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    { name: "tablet", viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false },
    { name: "desktop", viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
  ]) {
    const { name, ...options } = profile;
    const context = await browser.newContext(options);
    const target = await context.newPage();
    const devtools = await context.newCDPSession(target);
    try {
      await target.goto(`${origin}/qa/index.html?scene=home-populated`);
      await target.waitForFunction(() => window.qa?.snapshot().ready);
      await target.evaluate(async () => {
        window.scrollController = await import("/src/features/session/full-terminal/full-terminal.ts");
        window.scrollCapabilities = await import("/src/features/operations/capabilities-store.ts");
        const engine = await import("/src/features/session/full-terminal/full-terminal-xterm.ts");
        const originalOpen = engine.Terminal.prototype.open;
        engine.Terminal.prototype.open = function (...args) {
          window.scrollRenderer = this;
          window.scrollCapabilities.clearCapabilities();
          return originalOpen.apply(this, args);
        };
        await window.qa.setScene("terminal-core");
      });
      // Like a remote PTY, acknowledge the requested grid before replaying output.
      await target.evaluate(async () => {
        if (window.scrollRenderer.options.scrollback !== 1000) throw new Error("history capacity lost while config pending");
        const asked = () => {
          const call = window.qa.calls.filter(call => ["terminalOpen", "terminalResize"].includes(call.method)).at(-1);
          const offset = call?.method === "terminalResize" ? 2 : 1;
          if (!call) throw new Error("fixture terminal not open");
          return { cols: call.args[offset], rows: call.args[offset + 1] };
        };
        for (let attempt = 0; attempt < 20; attempt++) {
          const grid = asked();
          if (!window.qa.terminalFrame("", grid)) throw new Error("fixture terminal closed");
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const next = asked();
          if (next.cols === grid.cols && next.rows === grid.rows && window.scrollRenderer.cols === grid.cols && window.scrollRenderer.rows === grid.rows) break;
          if (attempt === 19) throw new Error("fixture grid did not settle");
        }
        if (!window.qa.terminalFrame(Array.from({ length: 300 }, (_, index) => `history_${String(index).padStart(4, "0")}\r\n`).join(""), asked())) throw new Error("fixture history not sent");
      });
      await target.waitForFunction(() => window.scrollController.fullTerminalScreenText("w1:p1").includes("history_0299"));
      await target.evaluate(() => window.scrollCapabilities.applyCapabilities({
        ...window.scrollCapabilities.operationCapabilities(), terminal_client_scroll: true,
      }, []));
      const read = () => target.evaluate(() => window.scrollController.fullTerminalScreenText("w1:p1"));
      const before = await read();
      await target.evaluate(() => window.qa.clearCalls());
      const host = await target.locator(".full-terminal-host").boundingBox();
      assert(host, `${name}: terminal host missing`);
      const horizontal = host.x + Math.min(host.width / 2, 190);
      const vertical = host.y + host.height * 0.38;
      const gesture = async () => {
        if (profile.hasTouch) {
          await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: horizontal, y: vertical }] });
          for (let distance = 20; distance <= 160; distance += 20) {
            await devtools.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: horizontal, y: vertical + distance }] });
          }
          await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await target.mouse.move(horizontal, vertical);
          await target.mouse.wheel(0, -220);
        }
      };
      await gesture();
      await target.waitForFunction(previous => window.scrollController.fullTerminalScreenText("w1:p1") !== previous, before);
      const after = await read();
      assert(/history_\d+/.test(after), `${name}: history viewport lost`);
      assert(!await target.evaluate(() => window.qa.calls.some(call => ["terminalScroll", "terminalInput"].includes(call.method))), `${name}: main history sent remote input`);

      await target.evaluate(() => window.qa.terminalFrame("\x1b[?1049h\x1b[?1000h\x1b[?1006hTUI ready", { full: false }));
      await target.waitForFunction(() => window.scrollController.fullTerminalScreenText("w1:p1").includes("TUI ready"));
      await target.evaluate(() => window.qa.clearCalls());
      await gesture();
      await target.waitForFunction(() => window.qa.calls.some(call => call.method === "terminalInput"));
      const reports = await target.evaluate(() => window.qa.calls.filter(call => call.method === "terminalInput").map(call => call.args[2]));
      const bytes = String.fromCharCode(...reports.flat());
      assert(/\x1b\[<64;\d+;\d+M/.test(bytes), `${name}: missing upward SGR wheel report`);
      assert(!await target.evaluate(() => window.qa.calls.some(call => ["terminalScroll", "terminalClose"].includes(call.method))), `${name}: mouse scrolling interrupted control`);
      const pageKey = async (direction = "up") => {
        await target.evaluate(direction => {
          window.qa.clearCalls();
          window.scrollController.sendFullTerminalScroll(direction, 23, "page_key");
        }, direction);
        await target.waitForFunction(() => window.qa.calls.some(call => call.method === "terminalInput"));
        const bytes = await target.evaluate(() => String.fromCharCode(...window.qa.calls
          .filter(call => call.method === "terminalInput").flatMap(call => call.args[2])));
        assert(bytes === (direction === "up" ? "\x1b[5~" : "\x1b[6~"), name + ": page button did not send exactly one page key");
      };
      await pageKey(); // Mouse mode must not turn a page button into wheel reports.
      await target.evaluate(() => window.qa.terminalFrame("\x1b[?1000l\x1b[?1006l", { full: false }));
      await target.waitForFunction(() => window.scrollRenderer.modes.mouseTrackingMode === "none");
      await target.evaluate(() => window.qa.clearCalls());
      await gesture(); // No guessed arrows in a non-mouse alternate screen.
      assert(!await target.evaluate(() => window.qa.calls.some(call => ["terminalScroll", "terminalInput", "terminalClose"].includes(call.method))), name + ": alternate swipe injected input or closed control");
      await pageKey("down");
      await target.evaluate(() => window.qa.terminalFrame("\x1b[?1049l\x1b[?1h\x1b[?2004l", { full: false }));
      await target.waitForFunction(() => window.scrollRenderer.buffer.active.type === "normal" && window.scrollRenderer.modes.applicationCursorKeysMode && !window.scrollRenderer.modes.bracketedPasteMode);
      await pageKey(); // less -X-like main-screen applications consume page keys.
      await target.evaluate(() => window.qa.terminalFrame("\x1b[?2004h", { full: false }));
      await target.waitForFunction(() => window.scrollRenderer.modes.bracketedPasteMode);
      const shellBefore = await read();
      await target.evaluate(() => {
        window.qa.clearCalls();
        window.scrollController.sendFullTerminalScroll("up", 23, "page_key");
      });
      await target.waitForFunction(previous => window.scrollController.fullTerminalScreenText("w1:p1") !== previous, shellBefore);
      assert(!await target.evaluate(() => window.qa.calls.some(call => ["terminalScroll", "terminalInput"].includes(call.method))), name + ": shell page key escaped local history");
      await target.evaluate(() => {
        window.scrollController.setFullTerminalComposeLive(true);
        window.scrollController.fullTerminalControlOptions().keyboard.open(true);
      });
      await target.locator(".xterm-helper-textarea").focus();
      await target.keyboard.type("x");
      await target.waitForFunction(() => window.qa.calls.some(call => call.method === "terminalInput" && call.args[2].includes(120)));

      await target.evaluate(() => {
        window.scrollCapabilities.clearCapabilities();
        window.qa.clearCalls();
        window.qa.terminalFrame("\x1b[?1000l\x1b[?1006l\x1b[?1049l", { full: false });
        window.qa.failNext("terminalScroll", "unsupported");
      });
      await target.waitForFunction(() => window.scrollRenderer.modes.mouseTrackingMode === "none");
      await gesture();
      await target.waitForFunction(() => window.qa.calls.some(call => call.method === "terminalScroll"));
      await target.evaluate(() => window.scrollController.fullTerminalControlOptions().keyboard.open(true));
      await target.locator(".xterm-helper-textarea").focus();
      await target.keyboard.type("y");
      await target.waitForFunction(() => window.qa.calls.some(call => call.method === "terminalInput" && call.args[2].includes(121)));
      const stage = await target.evaluate(() => window.scrollController.getFullTerminalView().stage);
      assert(stage === "live", `${name}: unsupported scroll stopped control`);
      results.push({ name, before: before.split("\n")[0], after: after.split("\n")[0], mouseReports: reports.length, pageRouting: "passed", alternateSwipe: "no input", stage });
    } finally {
      await context.close();
    }
  }
  return results;
}
