import { Maximize2, RefreshCw, X } from "lucide-react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { refreshWorkspace } from "./actions";
import { guardBackPress } from "./back-press";
import { closeWorkspaceInspector, expandWorkspaceInspector } from "./inspector";
import type { WorkspaceSnapshot } from "./model";
import { INSPECTOR_TAB_ORDER } from "./tab-order";
import { WorkspaceTabStrip } from "./tab-strip";

/**
 * Changes and files, then what the column itself can do: reload, grow into the
 * workspace screen, close. Changes lead because they are what the reader opens
 * the inspector for (`tab-order`). Close gives its corner to the session header's own
 * actions, so its press is guarded like a way back.
 */
export function InspectorHead({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const descriptor = snapshot.descriptor;
  return <header className="inspector-head">
    {descriptor?.features.git_status
      ? <WorkspaceTabStrip snapshot={snapshot} order={INSPECTOR_TAB_ORDER} kind="inspector" label={t("inspector.label")} />
      // Without Git status there is only the file view, so nothing to choose between.
      : <strong className="inspector-title">{t(descriptor ? "workspace.files" : "inspector.label")}</strong>}
    <div className="inspector-actions">
      <Button className="icon-btn" aria-label={t("workspace.refresh")} title={t("workspace.refresh")}
        disabled={snapshot.loading} onClick={() => void refreshWorkspace()}>
        <RefreshCw size={16} aria-hidden="true" />
      </Button>
      <Button className="icon-btn inspector-expand" aria-label={t("inspector.expand")} title={t("inspector.expand")}
        onClick={() => void expandWorkspaceInspector()}>
        <Maximize2 size={16} aria-hidden="true" />
      </Button>
      <Button className="icon-btn inspector-close" aria-label={t("inspector.close")} title={t("inspector.close")}
        onClick={(event) => {
          guardBackPress(event);
          closeWorkspaceInspector();
        }}>
        <X size={18} aria-hidden="true" />
      </Button>
    </div>
  </header>;
}
