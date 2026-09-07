/** Browser lifecycle is optional for CLI users of the protocol client. */
export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function watchPageVisibility(listener: (hidden: boolean) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const doc = document;
  const changed = () => listener(doc.visibilityState === "hidden");
  const win = typeof window === "undefined" ? null : window;
  doc.addEventListener("visibilitychange", changed);
  win?.addEventListener("pageshow", changed);
  return () => {
    doc.removeEventListener("visibilitychange", changed);
    win?.removeEventListener("pageshow", changed);
  };
}
