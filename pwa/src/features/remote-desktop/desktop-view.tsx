import { useState } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { DesktopScreen, type DesktopScreenProps } from "./desktop-surface";

/**
 * Compatibility wrapper for callers that mount RemoteDesktop inline without a
 * dedicated navigation route. New routes render `DesktopScreen` directly.
 */
export function RemoteDesktop(props: DesktopScreenProps) {
  const [opened, setOpened] = useState(false);
  if (opened) {
    return <DesktopScreen {...props} onBack={() => setOpened(false)} />;
  }
  return (
    <section className="desktop-entry">
      <Button className="btn btn-small" onClick={() => setOpened(true)}>
        {t("desktop.title")}
      </Button>
    </section>
  );
}
