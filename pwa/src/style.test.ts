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
const viewportSrc = await Bun.file(new URL("./viewport.ts", import.meta.url)).text();
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

function atRuleBody(header: string): string {
  const start = css.indexOf(header);
  if (start < 0) return "";
  const open = css.indexOf("{", start + header.length);
  if (open < 0) return "";
  let depth = 1;
  for (let index = open + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] !== "}") continue;
    depth--;
    if (depth === 0) return css.slice(open + 1, index);
  }
  return "";
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
    expect(rule(".add-mark::before")).toMatch(/linear-gradient\(currentColor/);
    expect(rule(".add-mark::before")).toMatch(/content:\s*""/);
    expect(css).toMatch(/\.chev,\s*\.group-chev,\s*\.pill-toggle::after\s*\{[^}]*clip-path:\s*polygon\(/);
    expect(rule(".pin-mark")).toMatch(/clip-path:\s*polygon\(/);
    expect(css).toMatch(/\.key-more::after,\s*\.icon-more::after\s*\{[^}]*box-shadow:/);
    expect(css).toMatch(/\.key-more\[aria-expanded="true"\]::after\s*\{[^}]*clip-path:\s*polygon\(/);
    expect(css).not.toMatch(/content:\s*"▾"|content:\s*"⌄"|content:\s*"›"|content:\s*"\+"/);
    expect(rule(".set-help::before")).toMatch(/content:\s*""/);
    expect(rule(".set-help::before")).toMatch(/mask:/);
    expect(rule(".set-help::before")).not.toMatch(/content:\s*"\?"/);
  });

  test("settings help copy is a centered dialog even on a phone width", () => {
    expect(rule("dialog.modal.help")).toMatch(/margin:\s*auto/);
    expect(rule("dialog.modal.help")).not.toMatch(/margin:\s*auto auto 0/);
    expect(css).toMatch(/@media \(max-width: 899\.98px\)[\s\S]*dialog\.modal\.help\s*\{[^}]*margin:\s*auto;/);
    expect(rule(".help-copy")).toMatch(/line-height:\s*1\.55/);
    expect(css).toMatch(/\.set-heading\s*\{[^}]*min-height:\s*44px/);
  });

  test("dialog confirm is the filled action and cancel stays quiet", () => {
    expect(rule(".btn-primary")).toMatch(/background:\s*var\(--accent\)/);
    expect(rule(".btn-ghost")).toMatch(/background:\s*transparent/);
    expect(rule(".btn-ghost")).not.toMatch(/var\(--accent\)/);
    expect(rule(".btn-ghost")).not.toMatch(/var\(--line-strong\)/);
    expect(rule("dialog.modal .action-row")).toMatch(/flex-direction:\s*column/);
  });

  test("interactive touch controls keep a 44px target", () => {
    for (const selector of [".manual-pair summary", ".btn-small", ".key", ".desk .key", ".text-link", ".topbar-create", ".back", ".send-btn", ".menu-item", ".icon-btn", ".card-main", ".operation-field input", ".operation-field select", ".lang-select", ".seg-item", ".dock-form textarea", ".chrome-title", ".row-act", ".switch-item", ".computer-forget", ".computer-add", ".set-nav", ".device-forget", ".full-terminal-action", ".full-terminal-scroll-btn", ".full-terminal-state-retry", ".full-terminal-kb", ".agent-step-summary", ".agent-process-summary", ".agent-older", ".agent-reply-copy", ".slash-cmd"]) {
      const match = rule(selector).match(/min-height:\s*(\d+)px/);
      expect(match, selector).not.toBeNull();
      expect(Number(match?.[1]), selector).toBeGreaterThanOrEqual(44);
    }
    expect(rule(".text-link")).toMatch(/min-width:\s*44px/);
    expect(rule(".agent-detail-retry")).toMatch(/min-height:\s*44px/);
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

  test("board canvas is a pan surface with compact chips and pane screens", () => {
    expect(rule(".board-canvas")).toMatch(/overflow:\s*hidden/);
    expect(rule(".board-canvas")).toMatch(/touch-action:\s*none/);
    expect(rule(".board-pane")).toMatch(/position:\s*absolute/);
    expect(rule(".board-pane")).toMatch(/touch-action:\s*none/);
    expect(css).toMatch(/\.board-chip,\s*\.board-tab,\s*\.board-tab-new\s*\{[^}]*min-height:\s*32px/);
    expect(css).toMatch(/\.board-rail\.overflow::after\s*\{[^}]*pointer-events:\s*none/);
    expect(rule(".board-pane-screen")).toMatch(/overflow:\s*hidden/);
    expect(rule(".board-pane-buffer")).toMatch(/transform-origin:\s*0 0/);
    expect(css).not.toMatch(/\.topbar-board\s*\{/);
  });

  test("workspace controls use a centered refresh mark and mobile-sized change rows", () => {
    expect(rule(".workspace-refresh::before")).toMatch(/mask:/);
    expect(rule(".workspace-refresh::before")).toMatch(/width:\s*18px/);
    expect(css).not.toMatch(/\.workspace-refresh::after\s*\{/);
    expect(rule(".workspace-change-group-title")).toMatch(/min-height:\s*44px/);
    expect(rule(".workspace-change")).toMatch(/min-height:\s*50px/);
    expect(rule(".workspace-layer-label")).not.toMatch(/border|border-radius|min-height/);
    expect(rule(".workspace-detail-name")).toMatch(/flex:\s*1/);
    expect(css).toMatch(/\.workspace-list-pending,\s*\.workspace-change-pending,\s*\.workspace-file-pending,\s*\.workspace-diff-pending\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.workspace-list-skeleton,\s*\.workspace-change-skeleton,\s*\.workspace-file-skeleton,\s*\.workspace-diff-skeleton\s*\{[^}]*flex:\s*1/);
    expect(rule(".workspace-file-skeleton-line")).toMatch(/height:\s*0\.62em/);
    expect(rule(".workspace-diff-skeleton-line")).toMatch(/grid-template-columns:\s*3\.2rem 3\.2rem/);
    expect(rule(".workspace-feedback-pane")).toMatch(/flex:\s*1/);
    expect(rule(".workspace-feedback-pane")).toMatch(/flex-direction:\s*column/);
    expect(css).not.toMatch(/\.workspace-file-pending-status\s*\{/);
    expect(css).toMatch(/\.workspace-main \{[^}]*flex-direction:\s*column/);
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
    expect(rule(".sheet-fact-val")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".sheet-fact-path")).toMatch(/font-family:\s*var\(--mono\)/);
    expect(rule(".sheet-fact-path")).toMatch(/word-break:\s*break-all/);
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

  test("mobile install allows page zoom while application gesture surfaces stay isolated", () => {
    expect(html).not.toContain("maximum-scale");
    expect(html).not.toContain("user-scalable");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('rel="mask-icon" href="/mask-icon.svg"');
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/pair");
    expect(manifest.scope).toBe("/pair");
    expect(manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "192x192")).toBe(true);
    expect(manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "512x512")).toBe(true);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    expect(rule("html, body")).toMatch(/touch-action:\s*pan-x pan-y pinch-zoom/);
    expect(main).toContain("bindLegacyGestureBoundary(document)");
  });

  test("mobile form controls do not trigger iOS focus zoom", () => {
    expect(css).toMatch(/@media \(max-width: 899\.98px\)[\s\S]*?\.operation-field input,[\s\S]*?font-size:\s*16px/);
    expect(css).toMatch(/@media \(max-width: 899\.98px\)[\s\S]*?\.lang-select[\s\S]*?font-size:\s*16px/);
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
    expect(rule(".full-terminal-host.is-pan")).toMatch(/touch-action:\s*none/);
    expect(rule(".full-terminal-host.is-pan .full-terminal-pan")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".full-terminal-host.is-pan .full-terminal-pan")).toMatch(/touch-action:\s*none/);
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

  test("terminal startup and failure states are centered above the canvas", () => {
    expect(rule(".full-terminal-state")).toMatch(/position:\s*absolute/);
    expect(rule(".full-terminal-state")).toMatch(/align-items:\s*center/);
    expect(rule(".full-terminal-state")).toMatch(/justify-content:\s*center/);
    expect(rule(".full-terminal-state")).toMatch(/text-align:\s*center/);
    expect(rule(".full-terminal-state")).toMatch(/z-index:\s*2/);
    expect(rule(".full-terminal-state-retry")).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.full-terminal-state-spinner\s*\{[^}]*animation:\s*none/);
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
    expect(viewportSrc).toContain('addEventListener("scroll", applyVisualViewport)');
    expect(viewportSrc).not.toMatch(/visualViewport\?\.addEventListener\("scroll", resized\)/);
    expect(main).toContain("bindVisualViewport");
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
    expect(rule(".agent-trace-limit")).toMatch(/color:\s*var\(--muted\)/);
    expect(rule(".agent-trace-limit")).not.toMatch(/position:\s*(sticky|fixed|absolute)/);
    expect(rule(".agent-empty")).toMatch(/justify-content:\s*center/);
    expect(rule(".agent-thinking-preview")).toMatch(/flex:\s*1 1 auto/);
    expect(rule(".agent-thinking-preview")).toMatch(/overflow:\s*hidden/);
    expect(rule(".agent-thinking-preview")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".agent-thinking-preview")).toMatch(/white-space:\s*nowrap/);
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
    expect(rule("#app.session")).toMatch(/top:\s*var\(--vv-top/);
    expect(rule("#app.session")).toMatch(/height:\s*var\(--vv-height/);
    expect(rule("#app.session")).not.toMatch(/height:\s*100dvh/);
    expect(rule("#app.session")).not.toMatch(/var\(--kb/);
    expect(rule("#app.desk")).toMatch(/position:\s*fixed/);
    expect(rule("#app.desk")).toMatch(/top:\s*var\(--vv-top/);
    expect(rule("#app.desk")).toMatch(/height:\s*var\(--vv-height/);
    expect(rule("#app.desk")).toMatch(/min-height:\s*0/);
    expect(rule("#app.desk")).toMatch(/overflow:\s*hidden/);
    expect(rule("#app.desk")).not.toMatch(/var\(--kb/);
    expect(rule("#app.desk")).not.toMatch(/height:\s*100dvh/);
    expect(rule("#app.desk")).not.toMatch(/min-height:\s*100dvh/);
    expect(rule(".main")).toMatch(/min-height:\s*0/);
    expect(rule(".main")).toMatch(/overflow:\s*hidden/);
  });

  test("complete-terminal compose pad sits below the host instead of overlaying it", () => {
    expect(rule(".full-terminal-root")).toMatch(/display:\s*flex/);
    expect(rule(".full-terminal-root")).toMatch(/flex-direction:\s*column/);
    expect(rule(".full-terminal-root")).toMatch(/min-height:\s*0/);
    expect(rule(".full-terminal-host")).toMatch(/flex:\s*1 1 0%/);
    expect(rule(".full-terminal-host")).toMatch(/min-height:\s*var\(--full-terminal-min-host-height, 128px\)/);
    expect(rule(".full-terminal-host")).toMatch(/overflow:\s*hidden/);
    expect(rule(".full-terminal-host")).not.toMatch(/position:\s*absolute/);
    expect(rule(".full-terminal-pad")).toMatch(/flex:\s*0 0 auto/);
    expect(rule(".full-terminal-pad")).toMatch(/min-height:\s*0/);
    expect(rule(".full-terminal-pad")).toMatch(/max-height:\s*calc\(var\(--vv-height, 100dvh\) - 53px - env\(safe-area-inset-top, 0px\) - var\(--full-terminal-min-host-height, 128px\)\)/);
    expect(rule(".full-terminal-pad")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".full-terminal-pad")).not.toMatch(/position:\s*(absolute|fixed)/);
  });

  test("short-landscape CSS contract reserves non-overlapping rows at 844x390", () => {
    const shortLandscape = atRuleBody("@media (max-height: 500px) and (orientation: landscape)");
    expect(shortLandscape).toMatch(/\.full-terminal-host\s*\{[^}]*display:\s*grid/);
    expect(shortLandscape).toMatch(/\.full-terminal-host\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 54px/);
    expect(shortLandscape).toMatch(/\.full-terminal-host\s*\{[^}]*min-height:\s*calc\(var\(--full-terminal-min-host-height, 128px\) \+ 54px\)/);
    expect(shortLandscape).toMatch(/\.full-terminal-pan\s*\{[^}]*grid-row:\s*1/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*flex-direction:\s*row/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*position:\s*static/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*z-index:\s*auto/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*grid-row:\s*2/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*max-width:\s*calc\(100% - 8px\)/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(shortLandscape).toMatch(/\.full-terminal-scroll\s*\{[^}]*overflow-y:\s*hidden/);
    expect(shortLandscape).toMatch(/\.full-terminal-pad\s*\{[^}]*max-height:\s*calc\([^}]* - 54px\)/);
    expect(rule(".full-terminal-scroll-btn")).toMatch(/min-width:\s*44px/);
    expect(rule(".full-terminal-scroll-btn")).toMatch(/min-height:\s*44px/);

    // Contract arithmetic only. Ego/Chromium owns the real getBoundingClientRect acceptance check.
    const chrome = { top: 0, bottom: 53 };
    const host = { top: chrome.bottom, bottom: chrome.bottom + 128 + 54 };
    const canvas = { top: host.top + 4, bottom: host.bottom - 4 - 54 };
    const rail = { top: canvas.bottom + 5, bottom: canvas.bottom + 5 + 44 };
    const pad = { top: host.bottom, bottom: host.bottom + (390 - 53 - 128 - 54) };
    expect(canvas).toEqual({ top: 57, bottom: 177 });
    expect(rail).toEqual({ top: 182, bottom: 226 });
    expect(pad).toEqual({ top: 235, bottom: 390 });
    expect(chrome.bottom).toBeLessThanOrEqual(canvas.top);
    expect(canvas.bottom).toBeLessThanOrEqual(rail.top);
    expect(rail.bottom).toBeLessThanOrEqual(host.bottom);
    expect(host.bottom).toBeLessThanOrEqual(pad.top);
  });

  test("portrait and desktop retain the vertical in-host rail baseline", () => {
    expect(rule(".full-terminal-scroll")).toMatch(/position:\s*absolute/);
    expect(rule(".full-terminal-scroll")).toMatch(/flex-direction:\s*column/);
    expect(rule(".full-terminal-scroll")).toMatch(/bottom:\s*10px/);
    expect(css).toContain("@media (min-width: 900px)");
  });

  test("complete-terminal keys keep 44px targets and wrap instead of cramming at 320px", () => {
    expect(rule(".full-terminal-pad :is(.keys)")).toMatch(/grid-auto-columns:\s*minmax\(44px, 1fr\)/);
    expect(rule(".full-terminal-pad :is(.keys)")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".full-terminal-pad :is(.key)")).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/@media \(max-width: 363\.98px\)[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(44px, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 363\.98px\)[\s\S]*?\.full-terminal-pad :is\(\.key-more\)[\s\S]*?grid-column:\s*1 \/ -1/);
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
    const cols = stateSrc.slice(stateSrc.indexOf("function loadTermCols"));
    expect(cols).toContain("TERM_COL_PRESETS.includes(raw as TermCols)");
    expect(cols).toContain("return 80");
  });

  test("terminal rows stay pannable", () => {
    expect(rule(".term-line")).toMatch(/touch-action:\s*pan-x pan-y/);
    expect(rule('[role="button"]')).toMatch(/touch-action:\s*manipulation/);
  });

  test("every key fits without a horizontal scroll strip", () => {
    expect(rule(".keys")).toMatch(/display:\s*grid/);
    expect(rule(".keys")).not.toMatch(/overflow-x:\s*auto/);
    expect(rule(".key")).toMatch(/min-width:\s*0/);
  });

  test("row actions sit in the flex column, not over the buffer", () => {
    expect(rule(".row-bar")).not.toMatch(/position:\s*absolute/);
    expect(rule(".session-extras")).toMatch(/flex:\s*0 0 auto/);
  });
});
