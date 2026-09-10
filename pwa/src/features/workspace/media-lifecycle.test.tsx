import { describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { WorkspaceMedia } from "./media";
import type { WorkspaceMediaView } from "./media-model";

// StrictMode player-element ownership: React mounts, runs effect cleanup, then
// mounts again on the same element. The owned element must be captured across the
// cleanup (a cleared hook ref must not leak), and effect SETUP must restore the
// current blob URL so a cleaned-then-remounted player keeps its live src. This is
// a real DOM lifecycle control (not a loader-callback registration stand-in).
const readyImage: WorkspaceMediaView = {
  path: "cat.png", role: "image", status: "ready", kind: "image", mime: "image/png",
  size: 4, loaded: 4, cap: 10 * 1024 * 1024, url: "blob:strict-image", error: "",
  width: 1, height: 1,
};
const readyVideo: WorkspaceMediaView = {
  path: "clip.mp4", role: "video", status: "ready", kind: "video", mime: "video/mp4",
  size: 4, loaded: 4, cap: 32 * 1024 * 1024, url: "blob:strict-video", error: "",
  width: 0, height: 0,
};

describe("media player element ownership (StrictMode)", () => {
  test("an image keeps its mounted src across StrictMode cleanup->setup", async () => {
    await resetBoardTestDOM();
    renderReact(<StrictMode><WorkspaceMedia media={readyImage} /></StrictMode>);
    const img = document.querySelector("img.workspace-media-image");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(readyImage.url);
    unmountReact();
    await happy.happyDOM.abort();
  });

  test("a video keeps its mounted src across StrictMode cleanup->setup", async () => {
    await resetBoardTestDOM();
    renderReact(<StrictMode><WorkspaceMedia media={readyVideo} /></StrictMode>);
    const video = document.querySelector("video.workspace-media-video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe(readyVideo.url);
    unmountReact();
    await happy.happyDOM.abort();
  });
});