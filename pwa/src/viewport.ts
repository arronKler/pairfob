export function isDesk(): boolean {
  return window.matchMedia("(min-width: 900px)").matches;
}
