import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { preparePageRefresh } from "../../lib/page-refresh";
import { updateInProgress } from "../../lib/daemon-update-status";
import { Button, Spinner } from "../../shared/ui/primitives";
import { daemonVersion } from "./daemon-update";

export function PageRefresh() {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);
  const updating = () => {
    const view = daemonVersion();
    return !!view?.requesting || !!view?.uncertain || updateInProgress(view?.status);
  };
  const refresh = async () => {
    if (pending.current || updating()) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("loading");
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const target = await preparePageRefresh(window.location.href, controller.signal);
      if (!controller.signal.aborted && !updating()) window.location.replace(target);
      if (pending.current === controller) setState("idle");
    } catch {
      // An unmounted control must not publish into a different screen.
      if (pending.current === controller) setState("failed");
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) pending.current = null;
    }
  };
  return <div className="page-refresh">
    <p className="set-note">{t("update.reloadNote")}</p>
    <Button className="btn btn-primary" disabled={state === "loading" || updating()} aria-busy={state === "loading"}
      onClick={() => void refresh()}>
      {state === "loading" ? <Spinner /> : null}{t(state === "loading" ? "update.reloading" : "update.reload")}
    </Button>
    {state === "failed" ? <p className="daemon-update-feedback" role="alert" data-tone="error">{t("update.reloadFailed")}</p> : null}
  </div>;
}
