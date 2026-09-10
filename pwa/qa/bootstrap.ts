import { installEnvironment, installStablePaint } from "./environment";

installEnvironment();
const query = new URLSearchParams(location.search);
const scene = query.get("scene") ?? "home-populated";
const language = query.get("lang") === "en" ? "en" : "zh";
// Only local source styles are accepted; the QA page always mounts the same
// stable production App with its production class/SCSS entries.
const style = query.get("style") ?? "/src/style.scss";
if (!/^\/src\/[a-zA-Z0-9/_-]+\.scss$/.test(style)) throw new Error("Invalid QA style entry (SCSS only)");

await import("/src/tailwind.css");
await import(/* @vite-ignore */ style);
installStablePaint();

const { createFixtureAPI } = await import("./fixtures");
window.qa = await createFixtureAPI(language, scene);
await window.qa.ready;