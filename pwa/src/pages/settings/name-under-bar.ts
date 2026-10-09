import { useEffect, useState } from "react";

/**
 * Whether the computer panel's own name has scrolled under the page's bar.
 *
 * The computer page names its computer in the panel at the top. The bar above
 * is titled with the kind of page while that name is in sight, and takes the
 * name over the moment it leaves, so the reader always sees it once and never
 * twice. The page scrolls the window on the phone and its own column beside
 * the list; a captured scroll hears either.
 */
const NAME = ".computer-panel .cp-name";

/** The name is under the bar once nothing of it shows below the bar's edge. */
export function nameUnderBar(name: Element | null): boolean {
  const bar = name?.closest(".computer-panel")?.parentElement?.querySelector(":scope > .topbar");
  if (!name || !bar) return false;
  const box = name.getBoundingClientRect();
  // A name that is not laid out has not been scrolled anywhere.
  return box.height > 0 && box.bottom <= bar.getBoundingClientRect().bottom;
}

export function useNameUnderBar(active: boolean): boolean {
  const [under, setUnder] = useState(false);
  useEffect(() => {
    if (!active) {
      setUnder(false);
      return;
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      setUnder(nameUnderBar(document.querySelector(NAME)));
    };
    const changed = () => { frame ||= requestAnimationFrame(read); };
    read();
    document.addEventListener("scroll", changed, { capture: true, passive: true });
    window.addEventListener("resize", changed);
    return () => {
      document.removeEventListener("scroll", changed, { capture: true });
      window.removeEventListener("resize", changed);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active]);
  return active && under;
}
