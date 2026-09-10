import type { ReactNode } from "react";
import { t } from "../../../lib/i18n";
import { showHelp, type HelpBlock } from "../overlay/basic-dialogs";
import { Button } from "./button";
import { Chevron } from "./navigation";
import { StatusDot, type StatusTone } from "./status";

/**
 * Label/value rows for a definition list.
 *
 * Values arrive resolved. The help button opens the shared help dialog with
 * whatever blocks the owning feature supplies, so help *content* and the policy
 * for showing it stay on the feature side.
 */
export function SetRow({ label, value, tone }: { label: string; value: string; tone?: StatusTone }) {
  return <div className="set-row"><span className="set-key">{label}</span>
    <span className="set-val">{tone && <StatusDot tone={tone} />}{value}</span>
  </div>;
}

export function SetNavRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return <Button className="set-row set-nav" aria-label={label} onClick={onClick}>
    <span className="set-key">{label}</span><span className="set-val">{value}<Chevron /></span>
  </Button>;
}

export function HelpButton({ title, blocks }: { title: string; blocks: HelpBlock[] | (() => HelpBlock[]) }) {
  return <Button className="icon-btn set-help" aria-label={t("settings.helpAria", { topic: title })} aria-haspopup="dialog"
    onClick={() => showHelp(title, typeof blocks === "function" ? blocks() : blocks)} />;
}

export function SetHeading({ text, help, children, className = "" }: {
  text: string; help?: HelpBlock[] | (() => HelpBlock[]); children?: ReactNode; className?: string;
}) {
  return <div className={`set-heading tw:flex tw:items-center${className ? ` ${className}` : ""}`}>
    <h2 className="set-title">{text}</h2>{children}{help && <HelpButton title={text} blocks={help} />}
  </div>;
}
