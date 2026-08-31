import { describe, expect, test } from "bun:test";

async function loadCss(url: URL): Promise<string> {
  const text = await Bun.file(url).text();
  const specs: string[] = [];
  const rest = text.replace(/@import\s+["']([^"']+)["']\s*;/g, (_match, spec: string) => {
    specs.push(spec);
    return "";
  });
  const imported = await Promise.all(specs.map((spec) => loadCss(new URL(spec, url))));
  return `${imported.join("\n")}\n${rest}`;
}

const css = await loadCss(new URL("./style.css", import.meta.url));
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const manifest = JSON.parse(await Bun.file(new URL("../public/manifest.webmanifest", import.meta.url)).text());
const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
const stateSrc = await Bun.file(new URL("./state.ts", import.meta.url)).text();

function color(token: string): string {
  const match = css.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`missing color token ${token}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
}

describe("UI accessibility guardrails", () => {
  test("status and error text meet WCAG AA contrast on every surface", () => {
    expect(contrast(color("error"), color("bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("error"), color("surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("ok"), color("surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("warn"), color("surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("accent"), color("bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color("accent-ink"), color("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", color("danger"))).toBeGreaterThanOrEqual(4.5);
  });

  test("manual pair disclosure draws a geometric chevron instead of a font glyph", () => {
    const chevron = rule(".manual-pair summary::after");
    expect(chevron).toMatch(/clip-path:\s*polygon\(/);
    expect(chevron).toMatch(/content:\s*""/);
    expect(chevron).not.toMatch(/var\(--faint\)/);
    expect(rule(".manual-pair[open] summary::after")).toMatch(/rotate\(180deg\)/);
    expect(rule(".btn-scan::before")).toMatch(/linear-gradient\(currentColor/);
    expect(css).toMatch(/\.chev,\s*\.group-chev,\s*\.pill-toggle::after\s*\{[^}]*clip-path:\s*polygon\(/);
    expect(css).toMatch(/\.key-more::after,\s*\.icon-more::after\s*\{[^}]*box-shadow:/);
    expect(css).toMatch(/\.key-more\[aria-expanded="true"\]::after\s*\{[^}]*clip-path:\s*polygon\(/);
    expect(css).not.toMatch(/content:\s*"▾"|content:\s*"⌄"|content:\s*"›"|content:\s*"\+"/);
  });

  test("dialog confirm is the filled action and cancel stays quiet", () => {
    expect(rule(".btn-primary")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".btn-ghost")).toMatch(/background:\s*transparent/);
    expect(rule(".btn-ghost")).not.toMatch(/var\(--accent\)/);
    expect(rule(".btn-ghost")).not.toMatch(/var\(--line-strong\)/);
    expect(rule("dialog.modal .action-row")).toMatch(/flex-direction:\s*column/);
  });

  test("interactive touch controls keep a 44px target", () => {
    for (const selector of [".manual-pair summary", ".btn-small", ".key", ".desk .key", ".text-link", ".topbar-create", ".back", ".lift button", ".send-btn", ".menu-item", ".icon-btn", ".operation-field input", ".operation-field select", ".seg-item", ".dock-form textarea", ".chrome-title", ".row-act", ".switch-item", ".computer-forget", ".full-terminal-action", ".full-terminal-scroll-btn", ".full-terminal-kb", ".agent-step-summary", ".agent-process-summary", ".agent-older", ".slash-cmd", ".home-feedback a", "a.set-nav"]) {
      const match = rule(selector).match(/min-height:\s*(\d+)px/);
      expect(match, selector).not.toBeNull();
      expect(Number(match?.[1]), selector).toBeGreaterThanOrEqual(44);
    }
    expect(rule(".text-link")).toMatch(/min-width:\s*44px/);
  });

  test("new-output chip sits on the left so it does not cover the TUI page rail", () => {
    expect(css).toMatch(/\.term-jump,\s*\.agent-jump\s*\{[^}]*left:\s*12px/);
    expect(css).toMatch(/\.term-jump,\s*\.agent-jump\s*\{[^}]*min-height:\s*44px/);
    expect(rule(".full-terminal-scroll")).toMatch(/right:\s*4px/);
  });

  test("page topbar keeps the title beside back and pins trailing actions with margin", () => {
    expect(rule(".topbar")).not.toMatch(/justify-content:\s*space-between/);
    expect(rule(".topbar")).toMatch(/z-index:\s*2/);
    expect(rule(".topbar-title")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".topbar-title")).toMatch(/min-height:\s*44px/);
    expect(rule(".topbar-actions")).toMatch(/margin-left:\s*auto/);
  });

  test("list create is a quiet plus chip, not a muted text link or a solid fill", () => {
    expect(rule(".topbar-create")).toMatch(/color:\s*var\(--accent\)/);
    expect(rule(".topbar-create")).not.toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".topbar-create")).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/\.topbar-create::before\s*\{[^}]*linear-gradient\(currentColor/);
  });

  test("settings back sits on the title row without the session-chrome glyph nudge", () => {
    expect(rule(".back")).not.toMatch(/padding-bottom/);
    expect(css).toMatch(/\.chrome \.back\s*\{[^}]*padding-bottom:\s*3px/);
    expect(css).toMatch(/\.settings-page \.topbar \.back,\s*\.main-settings \.topbar \.back\s*\{[^}]*margin-left:\s*-12px/);
    expect(css).toMatch(/\.settings-page \.topbar \+ \.lede\s*\{[^}]*margin-top:\s*14px/);
    expect(css).not.toMatch(/\.prelude \.topbar/);
  });

  test("session chrome icon buttons stay square when the title is long", () => {
    expect(rule(".icon-btn")).toMatch(/flex:\s*none/);
    expect(rule(".icon-btn")).toMatch(/min-width:\s*44px/);
    expect(rule(".icon-btn")).toMatch(/padding:\s*0/);
    expect(rule(".icon-stop::before")).toMatch(/width:\s*12px/);
    expect(rule(".icon-stop::before")).toMatch(/height:\s*12px/);
    expect(rule(".icon-stop")).not.toMatch(/border:\s*1px/);
    expect(rule(".icon-stop")).not.toMatch(/background:\s*rgba\(255, 178, 36/);
  });

  test("session sheets keep a close control on screen when the list is long", () => {
    expect(rule("dialog.modal.sheet")).toMatch(/overflow:\s*hidden/);
    expect(rule("dialog.modal.sheet")).toMatch(/padding:\s*0/);
    expect(rule(".sheet-head")).not.toMatch(/position:\s*sticky/);
    expect(rule(".sheet-head")).toMatch(/flex:\s*none/);
    expect(rule(".sheet-head")).toMatch(/background:\s*var\(--surface\)/);
    expect(rule(".sheet-body")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".sheet-body")).toMatch(/min-height:\s*0/);
    expect(rule(".sheet-close")).toMatch(/flex:\s*none/);
  });

  test("the connect loading screen fills the viewport and centers its copy", () => {
    expect(rule("#app.boot-screen")).toMatch(/position:\s*fixed/);
    expect(rule("#app.boot-screen")).toMatch(/top:\s*0/);
    expect(rule("#app.boot-screen")).toMatch(/bottom:\s*0/);
    expect(rule("#app.boot-screen")).toMatch(/height:\s*100svh/);
    expect(rule("#app.boot-screen")).toMatch(/align-items:\s*center/);
    expect(rule("#app.boot-screen")).toMatch(/justify-content:\s*center/);
    expect(rule(".boot")).toMatch(/align-items:\s*center/);
    expect(rule(".boot")).toMatch(/text-align:\s*center/);
    expect(rule(".boot")).not.toMatch(/position:\s*fixed/);
    expect(rule(".prelude.pairing")).toMatch(/justify-content:\s*center/);
    expect(rule(".prelude.pairing")).toMatch(/align-items:\s*center/);
  });

  test("session chrome is three zones with a compact phone action cluster", () => {
    expect(rule(".chrome")).toMatch(/gap:\s*8px/);
    expect(rule(".chrome-actions")).toMatch(/flex:\s*none/);
    expect(rule(".chrome-actions")).toMatch(/display:\s*flex/);
    expect(rule(".chrome-name")).toMatch(/min-width:\s*0/);
    expect(rule(".chrome-meta")).toMatch(/display:\s*flex/);
    expect(rule(".chrome-meta")).not.toMatch(/padding-left:\s*14px/);
  });

  test("session chrome stays above the terminal stacking context", () => {
    expect(rule(".chrome")).toMatch(/z-index:\s*2/);
    expect(rule(".chrome-title")).toMatch(/overflow:\s*hidden/);
  });

  test("mobile sheets animate the form, not the dialog box", () => {
    expect(css).toMatch(/dialog\.modal\s*>\s*form\s*\{[^}]*animation:\s*sheet-up/);
    expect(css).not.toMatch(/@media \(max-width: 899\.98px\)\s*\{\s*dialog\.modal\s*\{[^}]*animation:/);
  });

  test("compose is a growing textarea, not a single-line input", () => {
    expect(rule(".dock-form textarea")).toMatch(/min-height:\s*46px/);
    expect(rule(".dock-form textarea")).toMatch(/max-height:\s*8\.5rem/);
    expect(rule(".dock-form textarea")).toMatch(/resize:\s*none/);
    expect(css).not.toMatch(/\.dock-form input\[type=["']text["']\]/);
  });

  test("session compose live mode is marked on the field, not a dock switch", () => {
    expect(rule(".dock-form.live textarea")).toMatch(/border-color:\s*rgba\(110, 168, 254/);
    expect(css).not.toMatch(/\.compose-well/);
    expect(css).not.toMatch(/\.compose-mode-btn/);
  });

  test("the application exposes a main landmark", () => {
    expect(html).toContain('<main id="app"></main>');
  });

  test("mobile install runs as a fixed-scale standalone PWA", () => {
    expect(html).toContain("maximum-scale=1");
    expect(html).toContain("user-scalable=no");
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('rel="mask-icon" href="/mask-icon.svg"');
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/pair");
    expect(manifest.scope).toBe("/pair");
    expect(manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "512x512")).toBe(true);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    expect(rule("html, body")).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(main).toContain('["gesturestart", "gesturechange"]');
  });

  test("mobile form controls do not trigger iOS focus zoom", () => {
    expect(css).toMatch(/@media \(max-width: 899\.98px\)[\s\S]*?\.operation-field input,[\s\S]*?font-size:\s*16px/);
  });

  test("terminal rows tile on a pixel grid so phones do not show scanlines", () => {
    expect(css).toMatch(/--term-lh:\s*18px/);
    expect(rule(".term")).toMatch(/line-height:\s*var\(--term-lh\)/);
    expect(rule(".term")).toMatch(/text-size-adjust:\s*100%/);
    expect(rule(".term-line")).toMatch(/display:\s*flex/);
    expect(rule(".term-line")).toMatch(/height:\s*var\(--term-lh\)/);
    expect(rule(".term-line")).toMatch(/min-height:\s*1\.5em/);
    expect(rule(".term-line")).not.toMatch(/overflow:\s*hidden/);
    expect(rule(".term-line > span")).toMatch(/display:\s*block/);
  });

  test("the live xterm fills the host instead of a left-aligned gutter", () => {
    expect(rule(".full-terminal-host")).toMatch(/padding:\s*4px/);
    expect(rule(".full-terminal-host")).toMatch(/overflow:\s*hidden/);
    expect(rule(".full-terminal-host.is-pan")).toMatch(/touch-action:\s*pan-x/);
    expect(rule(".full-terminal-host.is-pan .full-terminal-pan")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".full-terminal-pan")).toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(/html\.full-terminal-active,\s*html\.full-terminal-active body\s*\{[^}]*-webkit-text-size-adjust:\s*none/);
    expect(css).toMatch(/html\.full-terminal-active,\s*html\.full-terminal-active body\s*\{[^}]*[^-]text-size-adjust:\s*none/);
    expect(rule(".full-terminal-host .xterm")).toMatch(/width:\s*100%/);
    expect(rule(".full-terminal-host .xterm")).toMatch(/height:\s*100%/);
    expect(rule(".full-terminal-host .xterm")).toMatch(/-webkit-text-size-adjust:\s*none/);
    expect(rule(".full-terminal-host .xterm")).toMatch(/(?:^|[;\s])text-size-adjust:\s*none/);
    expect(rule(".full-terminal-host .xterm")).toMatch(/font-kerning:\s*none/);
    expect(rule(".full-terminal-host .xterm")).not.toMatch(/text-rendering:\s*geometricPrecision/);
    expect(rule(".full-terminal-host .xterm-viewport")).toMatch(/overflow:\s*hidden/);
    expect(rule(".full-terminal-host .xterm-rows > div")).toMatch(/overflow:\s*hidden/);
    expect(rule(".full-terminal-host .xterm-rows > div")).toMatch(/clip-path:\s*inset\(0\)/);
    expect(rule(".full-terminal-host .xterm-rows")).toMatch(/line-height:\s*0/);
    expect(rule(".full-terminal-host .xterm-screen")).toMatch(/overflow:\s*hidden/);
    expect(rule(".full-terminal-host .xterm-screen")).not.toMatch(/transform-origin:\s*0 0/);
    expect(rule(".full-terminal-host")).not.toMatch(/padding:\s*5px 0 0 7px/);
  });

  test("long terminal lines expand the scrollport instead of being clipped", () => {
    expect(rule(".term")).toMatch(/min-width:\s*0/);
    expect(rule(".term")).toMatch(/overflow-y:\s*scroll/);
    expect(rule(".term")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".term")).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(rule(".term-wrap")).toMatch(/min-width:\s*0/);
    expect(rule(".pane-root")).toMatch(/min-width:\s*0/);
    expect(rule(".term-inner")).toMatch(/width:\s*max-content/);
    expect(rule(".term-inner")).toMatch(/min-width:\s*100%/);
    expect(rule(".term-line")).toMatch(/width:\s*max-content/);
    expect(rule(".term-line")).toMatch(/min-width:\s*100%/);
    expect(rule(".term-line")).not.toMatch(/overflow:\s*hidden/);
    expect(rule(".term-line > span")).toMatch(/white-space:\s*pre/);
  });

  test("a finger pan does not pin the terminal to the newest row", () => {
    expect(main).toContain('addEventListener("scroll", applyKeyboardInset)');
    expect(main).not.toMatch(/visualViewport\?\.addEventListener\("scroll", onViewportResize\)/);
    expect(main).toContain("stickBottom");
  });

  test("agent-chat stream is a definite box WebKit can pan", () => {
    expect(rule(".agent-stream-wrap")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".agent-stream-wrap")).toMatch(/min-height:\s*0/);
    expect(rule(".agent-stream-wrap")).toMatch(/position:\s*relative/);
    expect(rule(".agent-stream")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".agent-stream")).toMatch(/min-height:\s*0/);
    expect(rule(".agent-stream")).toMatch(/overflow-y:\s*scroll/);
    expect(rule(".agent-stream")).toMatch(/touch-action:\s*pan-y/);
    expect(rule(".agent-stream")).not.toMatch(/display:\s*flex/);
    expect(rule(".agent-stream-inner")).toMatch(/display:\s*flex/);
    expect(rule(".agent-older")).toMatch(/min-height:\s*44px/);
    expect(rule(".agent-older")).not.toMatch(/position:\s*(sticky|fixed|absolute)/);
    expect(rule(".agent-older[hidden]")).toMatch(/display:\s*none/);
    expect(rule(".agent-empty")).toMatch(/justify-content:\s*center/);
    expect(rule(".agent-empty")).toMatch(/align-items:\s*center/);
    expect(rule(".agent-stream-inner")).toMatch(/min-height:\s*100%/);
  });

  test("the terminal scrollport is a definite box WebKit can pan", () => {
    expect(rule(".term-wrap")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".term-wrap")).toMatch(/min-height:\s*0/);
    expect(rule(".term-wrap")).toMatch(/display:\s*flex/);
    expect(rule(".term")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".term")).toMatch(/min-height:\s*0/);
    expect(rule(".term")).not.toMatch(/position:\s*absolute/);
    expect(rule(".pane-root")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".pane-root")).toMatch(/overflow:\s*hidden/);
    expect(rule("#app.session")).toMatch(/inset:\s*0/);
    expect(rule("#app.session")).toMatch(/height:\s*auto/);
    expect(rule("#app.session")).not.toMatch(/height:\s*100dvh/);
    expect(rule("#app.desk")).toMatch(/position:\s*fixed/);
    expect(rule("#app.desk")).toMatch(/inset:\s*0/);
    expect(rule("#app.desk")).toMatch(/height:\s*auto/);
    expect(rule("#app.desk")).toMatch(/min-height:\s*0/);
    expect(rule("#app.desk")).toMatch(/overflow:\s*hidden/);
    expect(rule("#app.desk")).toMatch(/var\(--kb/);
    expect(rule("#app.desk")).not.toMatch(/height:\s*100dvh/);
    expect(rule("#app.desk")).not.toMatch(/min-height:\s*100dvh/);
    expect(rule(".main")).toMatch(/min-height:\s*0/);
    expect(rule(".main")).toMatch(/overflow:\s*hidden/);
  });

  test("standalone PWA paints the home-indicator strip with the app canvas", () => {
    expect(html).toContain('name="color-scheme" content="dark"');
    expect(html).toContain('name="theme-color" content="#0a0c10"');
    expect(html).toContain("viewport-fit=cover");
    expect(manifest.background_color).toBe("#0a0c10");
    expect(manifest.theme_color).toBe("#0a0c10");
    expect(rule(":root")).toMatch(/color-scheme:\s*dark/);
    expect(rule("html")).toMatch(/height:\s*-webkit-fill-available/);
    expect(rule("html, body")).toMatch(/min-height:\s*-webkit-fill-available/);
    expect(rule("html, body")).toMatch(/background:\s*var\(--bg\)/);
    expect(rule("#app")).toMatch(/min-height:\s*-webkit-fill-available/);
    expect(rule("#app")).toMatch(/background:\s*var\(--bg\)/);
  });

  test("phone history sheets do not nest a scroller in every item", () => {
    expect(css).toMatch(/@media \(max-width: 899\.98px\)[\s\S]*?\.history-text\s*\{[\s\S]*?max-height:\s*none/);
  });

  test("wrap mode reflows rows instead of forcing a horizontal drag", () => {
    expect(rule(".term.wrapped .term-inner")).toMatch(/width:\s*100%/);
    expect(rule(".term.wrapped .term-line")).toMatch(/display:\s*block/);
    expect(rule(".term.wrapped .term-line")).toMatch(/white-space:\s*pre-wrap/);
    expect(rule(".term.wrapped .term-line")).toMatch(/width:\s*auto/);
    expect(rule(".term.wrapped .term-line")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".term.wrapped .term-line > span")).toMatch(/display:\s*inline/);
  });

  test("the phone keeps the TUI grid and only wraps when the reader asks", () => {
    const wrap = stateSrc.slice(stateSrc.indexOf("function loadTermWrap"));
    expect(wrap).toContain('getItem(TERM_WRAP_KEY) === "1"');
    expect(wrap).not.toContain("return !isDesk()");
  });

  test("the live terminal defaults to 80 columns with a side pan", () => {
    const fit = stateSrc.slice(stateSrc.indexOf("function loadTermFit"));
    expect(fit).toContain('getItem(TERM_FIT_KEY) === "fit" ? "fit" : "pan"');
  });

  test("terminal rows stay pannable even when they are tap targets", () => {
    expect(rule(".term-line")).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(rule(".term [role=\"button\"]")).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(rule('[role="button"]')).toMatch(/touch-action:\s*manipulation/);
  });

  test("every key fits without a horizontal scroll strip", () => {
    expect(rule(".keys")).toMatch(/display:\s*grid/);
    expect(rule(".keys")).not.toMatch(/overflow-x:\s*auto/);
    expect(rule(".key")).toMatch(/min-width:\s*0/);
  });

  test("the lifted question and row actions sit in the flex column, not over the buffer", () => {
    expect(rule(".lift")).not.toMatch(/position:\s*absolute/);
    expect(rule(".row-bar")).not.toMatch(/position:\s*absolute/);
    expect(rule(".session-extras")).toMatch(/flex:\s*0 0 auto/);
  });
});
