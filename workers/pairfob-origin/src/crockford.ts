/** Crockford Base32 without I, L, O, U. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function normalizeLoc(raw: string): string | null {
  const t = raw
    .trim()
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V")
    .replace(/\s+/g, "");
  if (t.length !== 6) return null;
  for (let i = 0; i < 6; i++) {
    if (!CROCKFORD.includes(t[i])) return null;
  }
  return t;
}

export function locShard(loc: string): string {
  return loc.slice(0, 2);
}

export function mintLoc(random: (n: number) => Uint8Array): string {
  const b = random(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += CROCKFORD[b[i] % 32];
  return out;
}

export function indexName(loc: string): string {
  return "idx:" + locShard(loc);
}
