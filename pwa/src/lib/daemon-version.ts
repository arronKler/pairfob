// Official releases use numeric semver or date-based versions. Unknown builds
// are never ordered or advertised as an available downgrade.
export function releaseParts(value: unknown): number[] | null {
  if (typeof value !== "string" || value.length > 64 || !/^v?\d+(?:[.-]\d+){1,3}$/.test(value)) return null;
  const parts = value.replace(/^v/, "").split(/[.-]/).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function newerRelease(latest: string, current: string): boolean {
  const a = releaseParts(latest), b = releaseParts(current);
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function legacyBuild(build: string): boolean { return !build || build === "0.1.0"; }
