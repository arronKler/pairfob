import { useState } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import type { WorkspaceSnapshot } from "./model";

export const isHTMLFile = (path: string) => /\.html?$/i.test(path);
type PreviewMode = "preview" | "source";

/** The info bar and document share one state, scoped to the file being viewed. */
export function usePreviewControls(snapshot: WorkspaceSnapshot) {
  const key = `${snapshot.paneId}:${snapshot.descriptor?.root}:${snapshot.file?.path}:${snapshot.sourceLine}`;
  const initial = { key, mode: snapshot.sourceLine ? "source" as const : "preview" as const, started: !snapshot.sourceLine, reload: 0 };
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

export function PreviewSwitch({ controls }: { controls: PreviewControls }) {
  return <span className="workspace-layer-switch workspace-preview-switch" role="group" aria-label={t("preview.title")}>
    <Button aria-pressed={controls.mode === "preview"} onClick={() => controls.select("preview")}>{t("preview.preview")}</Button>
    <Button aria-pressed={controls.mode === "source"} onClick={() => controls.select("source")}>{t("preview.source")}</Button>
  </span>;
}
