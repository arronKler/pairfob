import { useState, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import type { WorkspaceSnapshot } from "./model";
import { PREVIEW_DESKTOP_WIDTH, setPreviewWidth, usePreviewWidth, type PreviewWidth } from "./prefs";
import { thumbAt } from "./thumb";

export { PREVIEW_DESKTOP_WIDTH };

export const isHTMLFile = (path: string) => /\.html?$/i.test(path);
export const isMarkdownFile = (path: string) => /\.(md|markdown)$/i.test(path);
type PreviewMode = "preview" | "source";

/** The info bar and document share one state, scoped to the file being viewed. */
export function usePreviewControls(snapshot: WorkspaceSnapshot) {
  const path = snapshot.file?.path ?? snapshot.detailPath;
  // A Markdown file is read as its source until the reader asks for the
  // document: the text they opened stays the default, as it did before the
  // preview existed. A line target is source's own, whatever the type.
  const markdown = isMarkdownFile(path);
  const key = `${snapshot.paneId}:${snapshot.descriptor?.root}:${snapshot.file?.path}:${snapshot.sourceLine}`;
  const initial = { key, markdown, mode: snapshot.sourceLine || markdown ? "source" as const : "preview" as const,
    started: !snapshot.sourceLine, reload: 0 };
  const [state, setState] = useState(initial);
  const current = state.key === key ? state : initial;
  if (state.key !== key) setState(initial);
  return {
    ...current,
    select: (mode: PreviewMode) => setState(value => ({ ...value, mode, started: value.started || mode === "preview" })),
    refresh: () => setState(value => ({ ...value, reload: value.reload + 1 })),
  };
}

export type PreviewControls = ReturnType<typeof usePreviewControls>;

/**
 * How wide the preview's stage is, as the preview measures it (`HTMLPreview`);
 * 0 while no preview is on the page. The info bar is drawn apart from the
 * stage, so the measure is shared here.
 */
let stageWidth = 0;
const stageListeners = new Set<() => void>();

export function notePreviewStage(width: number): void {
  const next = Math.max(0, Math.round(width));
  if (next === stageWidth) return;
  stageWidth = next;
  for (const listener of [...stageListeners]) listener();
}

function subscribeStage(listener: () => void): () => void {
  stageListeners.add(listener);
  return () => { stageListeners.delete(listener); };
}

export function usePreviewStageWidth(): number {
  return useSyncExternalStore(subscribeStage, () => stageWidth, () => 0);
}

const PREVIEW_DEVICE_WIDTHS = [375, 768] as const;
/** A phone's or a tablet's width is a question only where the stage can hold it with air on both sides. */
export const PREVIEW_WIDTH_STAGE_MIN = Math.max(...PREVIEW_DEVICE_WIDTHS) + 32;
/** Below this the info bar has no room for two segments beside its other controls; the PC width is one toggle instead. */
export const PREVIEW_COMPACT_STAGE = 340;

/**
 * The widths that are a question on a stage of this width. The stage's own
 * width (auto) is always one. A phone's and a tablet's are offered where the
 * stage is wider than both, so choosing one shows a boxed page. A PC's is
 * offered everywhere: on a narrow stage the page is wider than the stage, and
 * the preview reads it through its zoom surface; on a wide one it is a boxed
 * page like the others.
 */
export function previewWidthChoices(stage: number): readonly PreviewWidth[] {
  if (!(stage > 0)) return ["auto"];
  return stage >= PREVIEW_WIDTH_STAGE_MIN
    ? [...PREVIEW_DEVICE_WIDTHS, PREVIEW_DESKTOP_WIDTH, "auto"]
    : ["auto", PREVIEW_DESKTOP_WIDTH];
}

export function previewWidthOffered(stage: number): boolean {
  return previewWidthChoices(stage).length > 1;
}

/** The width the frame is held to, in pixels; null where the choice is not offered or is the room there is. */
export function usePreviewFrameWidth(): number | null {
  const stage = usePreviewStageWidth();
  const chosen = usePreviewWidth();
  return previewWidthChoices(stage).includes(chosen) && chosen !== "auto" ? chosen : null;
}

function widthLabel(width: PreviewWidth): string {
  if (width === "auto") return t("preview.widthAuto");
  return width === PREVIEW_DESKTOP_WIDTH ? t("preview.widthDesktop") : String(width);
}

function widthAria(width: PreviewWidth): string | undefined {
  return width === "auto" ? undefined : t("preview.widthPx", { width });
}

/**
 * On a stage with room, every width is a segment. On a very narrow one the bar
 * has room for one control only, so the PC width is one toggle: a chip that is
 * pressed while the PC width is what is shown.
 */
function WidthSwitch({ stage }: { stage: number }) {
  const chosen = usePreviewWidth();
  const choices = previewWidthChoices(stage);
  const active = choices.includes(chosen) ? chosen : "auto";
  if (stage < PREVIEW_COMPACT_STAGE) {
    const desktop = active === PREVIEW_DESKTOP_WIDTH;
    return <Button className="workspace-preview-pc" aria-pressed={desktop} aria-label={widthAria(PREVIEW_DESKTOP_WIDTH)}
      title={t("preview.widthDesktopTitle")} onClick={() => setPreviewWidth(desktop ? "auto" : PREVIEW_DESKTOP_WIDTH)}>
      {t("preview.widthDesktop")}
    </Button>;
  }
  return <span className="workspace-layer-switch workspace-preview-width" role="group" aria-label={t("preview.width")}
    style={thumbAt(choices.indexOf(active), choices.length)}>
    {choices.map((width) => <Button key={width} aria-pressed={active === width} aria-label={widthAria(width)}
      onClick={() => setPreviewWidth(width)}>{widthLabel(width)}</Button>)}
  </span>;
}

export function PreviewSwitch({ controls }: { controls: PreviewControls }) {
  const stage = usePreviewStageWidth();
  // A page is tried at a device's width; a Markdown document is simply read.
  const widths = controls.mode === "preview" && !controls.markdown && previewWidthOffered(stage);
  return <>
    <span className="workspace-layer-switch workspace-preview-switch" role="group"
      aria-label={t(controls.markdown ? "preview.markdownTitle" : "preview.title")}
      style={thumbAt(controls.mode === "preview" ? 0 : 1, 2)}>
      <Button aria-pressed={controls.mode === "preview"} onClick={() => controls.select("preview")}>{t("preview.preview")}</Button>
      <Button aria-pressed={controls.mode === "source"} onClick={() => controls.select("source")}>{t("preview.source")}</Button>
    </span>
    {widths && <WidthSwitch stage={stage} />}
  </>;
}
