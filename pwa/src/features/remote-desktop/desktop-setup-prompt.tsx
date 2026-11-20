import { useSyncExternalStore } from "react";
import { Monitor } from "lucide-react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { useComputers, useLiveSession } from "../computers/hooks";
import { useCapabilities } from "../operations/hooks";
import "./desktop.scss";

const DISMISS_PREFIX = "pairfob:desktopSetupDismissed:";
const dismissedMemory = new Set<string>();
const dismissListeners = new Set<() => void>();
let dismissRevision = 0;

export function desktopSetupDismissKey(daemonId: string): string {
  return `${DISMISS_PREFIX}${daemonId}`;
}

export function isDesktopSetupDismissed(daemonId: string): boolean {
  if (!daemonId) return true;
  if (dismissedMemory.has(daemonId)) return true;
  try {
    return localStorage.getItem(desktopSetupDismissKey(daemonId)) !== null;
  } catch {
    return false;
  }
}

export function dismissDesktopSetup(daemonId: string): void {
  if (!daemonId) return;
  dismissedMemory.add(daemonId);
  try {
    localStorage.setItem(desktopSetupDismissKey(daemonId), "1");
    dismissedMemory.delete(daemonId);
  } catch {
    /* in-memory fallback */
  }
  dismissRevision += 1;
  for (const listener of [...dismissListeners]) listener();
}

export function clearDesktopSetupDismissals(): void {
  dismissedMemory.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index) ?? "";
      if (key.startsWith(DISMISS_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* unavailable storage */
  }
  dismissRevision += 1;
  for (const listener of [...dismissListeners]) listener();
}

function subscribeDesktopSetupDismiss(listener: () => void): () => void {
  dismissListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key.startsWith(DISMISS_PREFIX)) {
      dismissRevision += 1;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    dismissListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Quiet, one-time discovery card in Settings Overview for upgraded macOS hosts
 * that advertise `setup_desktop` before `view_desktop` is enabled.
 */
export function DesktopSetupPrompt({
  onOpenSetup,
  connected,
}: {
  onOpenSetup: () => void;
  connected?: boolean;
}) {
  const caps = useCapabilities().operationCapabilities;
  const { credential } = useComputers();
  const live = useLiveSession();
  useSyncExternalStore(subscribeDesktopSetupDismiss, () => dismissRevision, () => dismissRevision);

  const daemonId = credential?.daemonId ?? "";
  const isConnected = connected ?? (live?.isConnected() === true);
  if (!isConnected || !daemonId || !caps.setup_desktop || caps.view_desktop || isDesktopSetupDismissed(daemonId)) {
    return null;
  }

  return (
    <aside className="set-group rd-setup-prompt" aria-label={t("desktop.promptTitle")}>
      <div className="set-card rd-setup-prompt-card">
        <div className="rd-setup-prompt-head">
          <div className="rd-setup-prompt-icon" aria-hidden="true">
            <Monitor size={18} />
          </div>
          <strong className="rd-setup-prompt-title">{t("desktop.promptTitle")}</strong>
        </div>
        <p className="rd-setup-prompt-body">{t("desktop.promptBody")}</p>
        <div className="rd-setup-prompt-actions">
          <Button className="btn btn-small btn-ghost" onClick={() => dismissDesktopSetup(daemonId)}>
            {t("desktop.promptDismiss")}
          </Button>
          <Button className="btn btn-small btn-primary" onClick={onOpenSetup}>
            {t("desktop.promptOpen")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
