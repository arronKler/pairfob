// Start `cd pwa && bun run dev -- --port 5186`, then prepend
// `globalThis.PAIRFOB_QA_SPACE = <existing ego task id>;` to this script and
// pipe it to `ego-browser nodejs`. The space belongs to the caller.
//
// The chat's Codex anatomy is one set of screens laid out by width and operated
// by pointer. This checks each surface it reaches: the dock's rows and targets,
// the reading column and gutter, the prompt's meta, the open reply, the work
// row, and the header stepping aside and returning with the tail pinned.
const assert = (value, message) => { if (!value) throw new Error(message); };
const near = (value, want, tolerance, message) =>
  assert(Math.abs(value - want) <= tolerance, `${message}: ${value} vs ${want}`);
const task = await taskSpace(Number(globalThis.PAIRFOB_QA_SPACE));
const page = task.page("p1");
const base = globalThis.PAIRFOB_QA_URL || "http://127.0.0.1:5186";
const out = "/tmp/pairfob-chat-anatomy-qa";
await (await import("node:fs/promises")).mkdir(out, { recursive: true });

// The anatomy includes the palette: the armed send is an ink mark. A browser
// someone switched to light keeps that choice in a cookie, so name the theme
// this checks instead of inheriting whatever the profile last wore.
await page.cdp("Network.setCookie", { name: "pairfob_theme", value: "dark", url: `${base}/` });

async function scene(name, width, height, touch) {
  await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 2, mobile: touch, screenWidth: width, screenHeight: height,
  });
  await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await page.goto(`${base}/qa/?scene=${name}&lang=zh`);
  await page.waitForFunction(() => document.querySelector(".agent-stream") !== null, undefined, { timeout: 30000 });
  await page.waitForTimeout(900);
}

function read() {
  return page.evaluate(() => {
    const q = (selector) => document.querySelector(selector);
    const box = (selector) => {
      const node = q(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    const css = (selector, props) => {
      const node = q(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]));
    };
    const stream = q(".agent-stream");
    return {
      viewport: { w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth },
      coarse: matchMedia("(any-pointer: coarse)").matches,
      stream: box(".agent-stream"),
      streamPad: css(".agent-stream", ["padding-left", "padding-right"]),
      thread: box(".agent-stream-inner"),
      bubble: box(".agent-user-bubble"),
      bubbleCss: css(".agent-user-bubble", ["font-size", "line-height", "border-radius", "background-color"]),
      meta: box(".agent-user-meta"),
      copy: box(".agent-user-copy"),
      replyCss: css(".agent-assistant .agent-md", ["font-size", "padding", "border-width", "background-color"]),
      workCard: css(".work-card", ["background-color", "border-width"]),
      workHead: box(".work-head"),
      reading: !!q(".agent-chrome .icon-reading"),
      dock: box(".agent-dock"),
      form: box(".agent-compose"),
      formCss: css(".agent-compose", ["display", "border-radius", "background-color"]),
      field: box(".agent-compose .compose-field"),
      textareaCss: css(".agent-compose textarea", ["font-size", "height"]),
      attach: box(".agent-compose .attach-btn"),
      send: box(".agent-compose .send-btn"),
      chrome: box(".agent-chrome"),
      collapsed: q(".agent-chrome")?.getAttribute("data-collapsed") ?? null,
      inert: q(".agent-chrome-inner")?.hasAttribute("inert") ?? null,
      peek: (() => {
        const node = q(".agent-peek");
        if (!node) return null;
        const style = getComputedStyle(node);
        return { opacity: style.opacity, events: style.pointerEvents };
      })(),
      gap: Math.round(stream.scrollHeight - stream.scrollTop - stream.clientHeight),
    };
  });
}

async function tap(selector) {
  const point = await page.evaluate((target) => {
    const r = document.querySelector(target).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);
  await page.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
  await page.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const surface of [
  { label: "phone", width: 390, height: 844, touch: true },
  { label: "tablet-820", width: 820, height: 768, touch: true },
  { label: "tablet-1024", width: 1024, height: 768, touch: true },
  { label: "desktop", width: 1440, height: 900, touch: false },
]) {
  await scene("chat-complete", surface.width, surface.height, surface.touch);
  const view = await read();
  assert(!(view.viewport.scrollW > view.viewport.w), `${surface.label}: page overflows horizontally`);
  assert(view.coarse === surface.touch, `${surface.label}: pointer is not the surface's`);
  assert(view.streamPad["padding-left"] === "16px" && view.streamPad["padding-right"] === "16px",
    `${surface.label}: the transcript gutter is not 16px`);
  near(Number.parseFloat(view.bubbleCss["font-size"]), surface.touch ? 15 : 13, 0.01, `${surface.label}: prompt font`);
  near(Number.parseFloat(view.bubbleCss["border-radius"]), 12, 0.01, `${surface.label}: prompt radius`);
  assert(view.bubbleCss["background-color"] !== "rgba(0, 0, 0, 0)", `${surface.label}: the prompt has no bubble ground`);
  assert(view.replyCss.padding === "0px" && view.replyCss["border-width"] === "0px"
    && view.replyCss["background-color"] === "rgba(0, 0, 0, 0)", `${surface.label}: the reply is still a card`);
  assert(view.replyCss["font-size"] === (surface.touch ? "16px" : "14px"), `${surface.label}: reply font`);
  assert(view.copy === null, `${surface.label}: the prompt still draws a copy button`);
  assert(view.reading, `${surface.label}: the header has no reading control`);
  assert(view.workCard["background-color"] === "rgba(0, 0, 0, 0)" && view.workCard["border-width"] === "0px",
    `${surface.label}: the work summary still draws a card`);
  if (surface.touch) {
    assert(view.formCss.display === "flex", `${surface.label}: the finger's dock is not one row`);
    near(view.attach.w, 44, 0, `${surface.label}: attach target`);
    near(view.send.w, 44, 0, `${surface.label}: send target`);
    near(Number.parseFloat(view.textareaCss["font-size"]), 16, 0, `${surface.label}: iOS-zoom-safe field`);
    near(view.workHead.h, 44, 0, `${surface.label}: work row target`);
    assert(view.form && view.form.w <= 768, `${surface.label}: the dock passes its column`);
  } else {
    assert(view.formCss.display === "grid", `${surface.label}: the mouse's dock is not two rows`);
    near(view.field.w, 722, 2, `${surface.label}: field width inside the frame`);
    near(view.meta.h, 24, 0, `${surface.label}: prompt meta row`);
    near(view.attach.w, 32, 0, `${surface.label}: attach target`);
    near(view.send.w, 32, 0, `${surface.label}: send target`);
    near(view.thread.w, 768, 0, `${surface.label}: desk reading column`);
    assert(view.chrome.h === 53, `${surface.label}: the header is not its resting height`);
    const compose = await page.evaluate(() => {
      const r = document.querySelector(".agent-compose").getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    near(compose.w, 744, 2, `${surface.label}: dock frame width`);
    near(compose.h, 89, 2, `${surface.label}: dock frame height`);
  }
  await page.screenshot({ path: `${out}/${surface.label}.png` });
}

// The header steps aside while the reader is away, and the peek brings it back.
for (const surface of [{ label: "phone", width: 390, height: 844, touch: true }]) {
  await scene("chat-pi-unread", surface.width, surface.height, surface.touch);
  let view = await read();
  assert(view.collapsed === "1" && view.inert === true, `${surface.label}: the header did not step aside`);
  assert(view.peek.opacity === "1" && view.peek.events === "auto", `${surface.label}: the peek is out of reach`);
  assert(view.chrome.h === 0, `${surface.label}: the collapsed header still takes height`);
  await tap(".agent-peek");
  await page.waitForTimeout(600);
  view = await read();
  assert(view.collapsed === null && view.inert === false, `${surface.label}: the peek did not reveal the header`);
  assert(view.chrome.h === 53, `${surface.label}: the revealed header did not take its height`);
  await page.screenshot({ path: `${out}/${surface.label}-peek.png` });
}

// A real wheel returns to the tail; the header returns and the last turn stays against the dock.
await scene("chat-pi-unread", 1440, 900, false);
await page.mouse.move(900, 350, { label: "move over the transcript" });
await page.mouse.wheel(0, -1200, { label: "scroll up into the transcript" });
await page.waitForTimeout(1300);
let view = await read();
assert(view.collapsed === "1" && view.peek.opacity === "1", "desktop: the header did not step aside on a real wheel");
assert(view.gap > 32, "desktop: the wheel did not leave the tail");
await page.mouse.wheel(0, 6000, { label: "scroll back to the tail" });
await page.waitForTimeout(1600);
view = await read();
assert(view.collapsed === null, "desktop: the header did not return at the tail");
assert(view.chrome.h === 53, "desktop: the returned header is not at its resting height");
near(view.gap, 0, 1, "desktop: the last turn is not against the dock after the header returns");
assert(view.peek.opacity === "0" && view.peek.events === "none", "desktop: the peek stays active under the header");
await page.screenshot({ path: `${out}/desktop-tail.png` });

// Typing and Enter belong to the same dock: the field sends, the draft clears, the tail pins.
await page.mouse.click(800, 806, { label: "focus the chat field" });
await page.keyboard.type("检查桌面端的发送");
await page.waitForTimeout(250);
view = await read();
const typed = await page.evaluate(() => ({
  draft: document.querySelector(".agent-compose textarea").value,
  focused: document.activeElement === document.querySelector(".agent-compose textarea"),
  send: document.querySelector(".agent-compose .send-btn").className,
  ground: getComputedStyle(document.querySelector(".agent-compose .send-btn")).backgroundColor,
}));
assert(typed.focused, "desktop: the mouse did not focus the field");
assert(typed.draft === "检查桌面端的发送", "desktop: typing did not reach the field");
assert(typed.send.includes("send-kind-send") && typed.ground === "rgb(233, 237, 243)",
  "desktop: a typed draft did not arm the send");
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
const sent = await page.evaluate(() => ({
  draft: document.querySelector(".agent-compose textarea").value,
  last: [...document.querySelectorAll(".agent-user-text")].at(-1)?.textContent,
}));
assert(sent.draft === "" && sent.last === "检查桌面端的发送", "desktop: Enter did not send the prompt");
view = await read();
near(view.gap, 0, 1, "desktop: the sent prompt did not land at the tail");
assert(view.collapsed === null, "desktop: the header did not return at the tail");

// The reading size: the header control walks every line up and back down, and
// wider code keeps its copy button out of the words.
await scene("chat-complete", 390, 844, true);
await tap(".icon-reading");
await page.waitForTimeout(400);
for (let i = 0; i < 4; i++) {
  await tap('[aria-label="文字加大"]');
  await page.waitForTimeout(250);
}
await tap(".chat-reading-sheet .sheet-close");
await page.waitForTimeout(500);
view = await read();
assert(view.replyCss["font-size"] === "22px", "phone: the reading control did not reach its largest step");
const blocks = await page.evaluate(() => [...document.querySelectorAll(".md-code")].map((frame) => {
  const pre = frame.querySelector("pre");
  const button = frame.querySelector(".md-copy");
  return {
    inline: frame.classList.contains("is-inline"),
    textEnd: pre.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(pre).paddingRight),
    buttonLeft: button.getBoundingClientRect().left,
  };
}));
assert(blocks.length > 0, "phone: the scene draws no code block");
for (const block of blocks) assert(!block.inline || block.textEnd <= block.buttonLeft,
  "phone: the code copy button covers the code at the largest size");
await page.screenshot({ path: `${out}/phone-size-largest.png` });
await tap(".icon-reading");
await page.waitForTimeout(400);
for (let i = 0; i < 4; i++) {
  await tap('[aria-label="文字减小"]');
  await page.waitForTimeout(250);
}
await tap(".chat-reading-sheet .sheet-close");
await page.waitForTimeout(500);
view = await read();
assert(view.replyCss["font-size"] === "16px", "phone: stepping back did not return to the finger's automatic size");
const kept = await page.evaluate(() => localStorage.getItem("pairfob.chat.fontSize"));
assert(kept === null, "phone: the automatic size was left as a choice");

console.log(JSON.stringify({ ok: true, shots: out }));
