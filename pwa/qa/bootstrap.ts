import { installEnvironment, installStablePaint } from "./environment";

installEnvironment();
const query = new URLSearchParams(location.search);
const scene = query.get("scene") ?? "home-populated";
const language = query.get("lang") === "en" ? "en" : "zh";
// Only local source styles are accepted; the QA page always mounts the same
// stable production App with its production class/SCSS entries.
const style = query.get("style") ?? "/src/startup.scss";
if (!/^\/src\/[a-zA-Z0-9/_-]+\.scss$/.test(style)) throw new Error("Invalid QA style entry (SCSS only)");

await import("/src/tailwind.css");
await import("/src/shared/ui/fonts/icon-font.css");
await import(/* @vite-ignore */ style);
// `motion=1` leaves animation and transitions running, for looking at motion itself;
// every other use keeps the frozen paint the saved captures were taken with.
if (query.get("motion") !== "1") installStablePaint();

const { createFixtureAPI } = await import("./fixtures");
// The palette is part of the first frame a reader sees, and the fixture mounts
// the production App: paint the stored side before the first commit, as boot does.
const { applyDocumentTheme } = await import("../src/lib/theme");
applyDocumentTheme();
window.qa = await createFixtureAPI(language, scene);
await window.qa.ready;