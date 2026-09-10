/**
 * Fresh-process probe for the first-mount shell-before-render contract.
 *
 * Each test file shares one Bun worker with its neighbours, and `mock.module`
 * does not reliably restore a mocked ESM module for other suites, so this probe
 * runs in its own process. It installs a real Happy DOM realm, replaces only the
 * `pages/boot` BootScreen with a leaf that measures in its own layout effect whether
 * the shell (`boot-screen` on `#app`) was already applied, then mounts the real
 * `<App/>` for the boot composition and asserts the leaf observed the shell.
 *
 * A mutation that clears the shell before the first React commit (or otherwise
 * defers `applyShell` past the first child layout effect) makes `observed` false
 * and the probe exits non-zero.
 *
 * Run with `bun scripts/shell-before-render-probe.ts` from `pwa/`.
 */

import { createElement, useLayoutEffect } from "react";
import { act } from "react";
import { mock } from "bun:test";

await import("../test-support/boot-dom");
import { resetBoardTestDOM } from "../test-support/dom";
await resetBoardTestDOM();

const { fileURLToPath } = await import("node:url");
const pwaRoot = fileURLToPath(new URL("..", import.meta.url));

let observed: boolean | undefined;
mock.module(`${pwaRoot}/src/pages/boot/index.tsx`, () => ({
  BootScreen: function MeasuringBoot() {
    useLayoutEffect(() => {
      observed = document.getElementById("app")?.classList.contains("boot-screen");
    }, []);
    return createElement("div", { className: "boot-shell-probe" });
  },
}));

const { mountApp, unmountApp, isAppMounted } = await import("../src/app/mount");
const { getAppFrame } = await import("../src/app/frame");
const { setPhase } = await import("../src/features/connection/connection-store");
const { setScreen } = await import("../src/app/navigation-store");

setPhase("boot");
setScreen("home");

let shellAtNotification: boolean | undefined;
const { subscribeAppFrame } = await import("../src/app/frame");
const release = subscribeAppFrame(() => {
  if (shellAtNotification === undefined) {
    shellAtNotification = document.getElementById("app")?.classList.contains("boot-screen");
  }
});

let ok = false;
let error: string | undefined;
try {
  act(() => {
    mountApp();
  });
  const mountedProbe = document.querySelector(".boot-shell-probe");
  const layoutMode = getAppFrame().layout?.mode;
  const mounted = isAppMounted();

  if (mountedProbe === null) error = "boot probe leaf was not rendered by the mounted App";
  else if (observed !== true) error = "shell was not applied before the boot leaf's first layout effect";
  else if (layoutMode !== "boot") error = `layout mode was ${layoutMode}, expected boot`;
  else if (!mounted) error = "App did not stay mounted";
  else if (mounted && shellAtNotification !== true) error = "shell not applied at first frame notification";
  else ok = true;
} catch (caught) {
  error = String(caught);
} finally {
  act(() => {
    unmountApp();
  });
  release();
}

console.log(JSON.stringify({ ok, observed, shellAtNotification, error }, null, 2));
process.exit(ok ? 0 : 1);
