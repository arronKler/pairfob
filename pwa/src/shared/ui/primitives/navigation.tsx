import type { ReactNode } from "react";
import { t } from "../../../lib/i18n";
import { Button } from "./button";

/** Geometric disclosure/next mark. The glyph is drawn by CSS, never by text. */
export function Chevron({ className = "chev" }: { className?: string }) {
  return <span className={className} aria-hidden="true" />;
}

export function BackButton({ onBack, label }: { onBack: () => void; label?: string }) {
  return <Button className="icon-btn back" onClick={onBack} aria-label={label ?? t("chrome.back")}>‹</Button>;
}

export function BackBar({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return <div className="topbar"><BackButton onBack={onBack} /><h1 className="topbar-title">{title}</h1>{children}</div>;
}
