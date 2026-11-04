import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../home-app.js", import.meta.url)).text();
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const head = html.slice(0, html.indexOf("</head>"));

/** Run home-app.js against a stand-in window and report where it navigated. */
function launch(opts: { standalone?: boolean; modes?: string[]; matchMedia?: boolean }): string | null {
  let target: string | null = null;
  const modes = new Set(opts.modes ?? []);
  const win: Record<string, unknown> = {
    navigator: opts.standalone === undefined ? {} : { standalone: opts.standalone },
    location: { replace: (url: string) => { target = url; } },
  };
  if (opts.matchMedia !== false) {
    win.matchMedia = (query: string) => ({ matches: [...modes].some(mode => query === `(display-mode: ${mode})`) });
  }
  Function("window", source)(win);
  return target;
}

describe("homepage as a home-screen app", () => {
  test("links the app manifest and the iOS web-app tags", () => {
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(head).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(head).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
    expect(head).toContain('<meta name="apple-mobile-web-app-title" content="Pairfob" />');
  });

  test("loads the launch hand-off before any other script", () => {
    const first = head.match(/<script\b[^>]*src="([^"]+)"/);
    expect(first?.[1]).toMatch(/^\/home-app\.js\?v=\d+$/);
  });

  test("an iOS home-screen launch opens the app", () => {
    expect(launch({ standalone: true })).toBe("/pair");
  });

  test("an installed launch on other browsers opens the app", () => {
    expect(launch({ modes: ["standalone"] })).toBe("/pair");
    expect(launch({ modes: ["fullscreen"] })).toBe("/pair");
    expect(launch({ modes: ["minimal-ui"] })).toBe("/pair");
  });

  test("a browser tab keeps the homepage", () => {
    expect(launch({ standalone: false, modes: ["browser"] })).toBeNull();
    expect(launch({ matchMedia: false })).toBeNull();
  });
});
