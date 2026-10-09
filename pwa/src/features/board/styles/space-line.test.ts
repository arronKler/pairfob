import { expect, test } from "bun:test";
import { compile } from "sass";
import { fileURLToPath } from "node:url";

const chrome = compile(fileURLToPath(new URL("./board-chrome.scss", import.meta.url)), { style: "expanded" }).css;

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return chrome.match(new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

/** The switcher's rows and the header's line separate their parts the same way. */
test("a workspace's path and marks are parted by a dot, and only the path is cut", () => {
  const dot = /content:\s*"·";\s*margin:\s*0 5px/;
  expect(rule(".board-title-line > * + *::before")).toMatch(dot);
  expect(rule(".board-space-line > * + *::before")).toMatch(dot);
  expect(rule(".board-space-line > *")).toMatch(/flex:\s*none/);
  const path = rule(".board-space-line > .board-space-path");
  expect(path).toMatch(/flex:\s*0 1 auto/);
  expect(path).toMatch(/min-width:\s*0/);
  expect(path).toMatch(/text-overflow:\s*ellipsis/);
});
