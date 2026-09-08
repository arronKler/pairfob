import { installEnvironment, installStablePaint } from "./environment";
import type { FixtureMode } from "./types";

installEnvironment();
const query = new URLSearchParams(location.search);
const mode: FixtureMode = query.get("mode") === "baseline" ? "baseline" : "react";
const language = query.get("lang") === "en" ? "en" : "zh";
const style = query.get("style") ?? (mode === "react" ? "/src/style.scss" : "/src/style.css");
// Only local source styles are accepted; baseline does not resolve any React imports.
if (!/^\/src\/[a-zA-Z0-9/_-]+\.(?:css|scss)$/.test(style)) throw new Error("Invalid QA style entry");
if (mode === "react") {
  const tailwind = "/src/tailwind.css";
  await import(/* @vite-ignore */ tailwind);
}
await import(/* @vite-ignore */ style);
installStablePaint();
const { createFixtureAPI } = await import("./fixtures");
window.qa = await createFixtureAPI(mode, language, query.get("scene") ?? "home-populated");
await window.qa.ready;
