import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { t } from "../../../lib/i18n";
import { guardBackTap } from "../dom/back-tap";
import { Button } from "./button";

/** Decorative disclosure mark; the owning control provides its accessible name. */
export function Chevron({ className = "chev" }: { className?: string }) {
  return <ChevronRight className={className} size={16} aria-hidden="true" />;
}

/**
 * Every screen's way back. A pointer press arms the double-tap guard before the
 * screen changes, so the second half of a doubled tap presses nothing on the
 * screen that comes up under it (`dom/back-tap.ts`); a key goes straight back.
 */
export function BackButton({ onBack, label }: { onBack: () => void; label?: string }) {
  return <Button className="icon-btn back" aria-label={label ?? t("chrome.back")} onClick={(event) => {
    if (event.detail !== 0) guardBackTap(event.currentTarget.ownerDocument, { x: event.clientX, y: event.clientY });
    onBack();
  }}><ChevronLeft size={24} aria-hidden="true" /></Button>;
}

/** `hideTitle` keeps the heading for assistive tech when the page shows its name in its own content. */
export function BackBar({ title, onBack, hideTitle = false, children }: { title: string; onBack: () => void; hideTitle?: boolean; children?: ReactNode }) {
  return <div className="topbar"><BackButton onBack={onBack} /><h1 className={hideTitle ? "topbar-title sr-only" : "topbar-title"}>{title}</h1>{children}</div>;
}

/** Trailing page actions keep intrinsic targets and align right even when wrapped. */
export function TopbarActions({ className = "", ...props }: ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={`topbar-actions${className ? ` ${className}` : ""}`} />;
}
