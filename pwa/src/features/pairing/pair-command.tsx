import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";

const PAIR_COMMAND = "pairfob pair";

/**
 * The command that starts pairing, as a terminal line with a copy button. The
 * computer to control is often the one this browser runs on, so the command is
 * one click from its terminal. The copy result replaces the label for a moment.
 */
export function PairCommand() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    // Called inside the click: some browsers only allow clipboard writes there.
    const write = navigator.clipboard?.writeText(PAIR_COMMAND) ?? Promise.reject(new Error("no clipboard"));
    void write.then(() => setState("copied"), () => setState("failed"));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <div className="connect-command">
      <span className="connect-command-prompt" aria-hidden="true">~ %</span>
      <code>{PAIR_COMMAND}</code>
      <Button className="connect-command-copy" onClick={copy} aria-label={t("empty.copyAria", { command: PAIR_COMMAND })}>
        <Copy size={13} aria-hidden="true" />
        <span aria-live="polite">{state === "copied" ? t("empty.copied") : state === "failed" ? t("empty.copyFailed") : t("empty.copy")}</span>
      </Button>
    </div>
  );
}
