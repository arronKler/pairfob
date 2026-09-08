import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { fullTerminalStateTitle } from "../full-terminal-state";
import { getFullTerminalView, subscribeFullTerminalView } from "../full-terminal-view";

export function FullTerminalStateLayer({ onRetry }: { onRetry: () => void }) {
  const view = useSyncExternalStore(subscribeFullTerminalView, getFullTerminalView);
  const live = view.stage === "live";
  return (
    <section
      className="full-terminal-state"
      hidden={live}
      data-stage={view.stage}
      role={view.stage === "error" ? "alert" : "status"}
      aria-live={view.stage === "error" ? "assertive" : "polite"}
    >
      <span className="full-terminal-state-spinner" aria-hidden="true" />
      <div className="full-terminal-state-copy">
        <strong className="full-terminal-state-title">{fullTerminalStateTitle(view.stage)}</strong>
        <p className="full-terminal-state-detail">{view.detail}</p>
      </div>
      <button
        type="button"
        className="full-terminal-state-retry"
        hidden={!view.retry}
        disabled={view.busy}
        onClick={onRetry}
      >
        {t("ft.retry")}
      </button>
    </section>
  );
}
