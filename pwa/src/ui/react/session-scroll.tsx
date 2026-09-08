import { useEffect, useRef, useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { bindScrollHold, type RemoteScroll } from "../full-terminal-scroll";
import { pagePendingCounts, pagePendingStoreRevision, subscribePagePending } from "../session/keys";

function ScrollHoldButton({
  mark,
  aria,
  pending,
  onFire,
}: {
  mark: string;
  aria: string;
  pending: boolean;
  onFire: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  useEffect(() => {
    const el = btnRef.current;
    if (!el) return;
    return bindScrollHold(el, () => fireRef.current());
  }, []);
  return (
    <button
      ref={btnRef}
      type="button"
      className={`full-terminal-scroll-btn ${mark}${pending ? " is-pending" : ""}`}
      aria-label={aria}
      title={aria}
      aria-busy={pending ? true : undefined}
    />
  );
}

/**
 * Guided / complete-terminal page-and-wheel rail. Markup matches `scrollRail()`:
 * `.full-terminal-scroll[role=group] > .full-terminal-scroll-btn`. Bind hold
 * repeat in an effect and dispose it on unmount. The `scroll` callback is
 * invoked only from pointer/keyboard activation, never while rendering.
 */
export function SessionScrollRail({
  scroll,
  pageLines,
}: {
  scroll: RemoteScroll;
  pageLines: () => number;
}) {
  useSyncExternalStore(subscribePagePending, pagePendingStoreRevision);
  const counts = pagePendingCounts();
  const busy = counts.up + counts.down > 0;
  const fire = (direction: "up" | "down", source: "wheel" | "page_key", lines: number | (() => number)) => {
    const count = typeof lines === "function" ? lines() : lines;
    scroll(direction, Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1, source);
  };
  return (
    <div
      className="full-terminal-scroll"
      role="group"
      aria-label={t("keys.scrollAria")}
      aria-busy={busy ? true : undefined}
      data-react-session-scroll=""
    >
      <ScrollHoldButton mark="scroll-up" aria={t("keys.wheelUp")} pending={false} onFire={() => fire("up", "wheel", 3)} />
      <ScrollHoldButton
        mark="scroll-page-up"
        aria={t("keys.pageUp")}
        pending={counts.up > 0}
        onFire={() => fire("up", "page_key", pageLines)}
      />
      <ScrollHoldButton
        mark="scroll-page-down"
        aria={t("keys.pageDown")}
        pending={counts.down > 0}
        onFire={() => fire("down", "page_key", pageLines)}
      />
      <ScrollHoldButton mark="scroll-down" aria={t("keys.wheelDown")} pending={false} onFire={() => fire("down", "wheel", 3)} />
    </div>
  );
}
