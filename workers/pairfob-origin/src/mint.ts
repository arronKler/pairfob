import { randomHex, sha256Hex } from "./crypto.ts";

export async function mintJoinGrant(opts?: {
  max_daemons?: number;
  label?: string | null;
}): Promise<{ grant_id: string; join_grant: string; grant_hash: string; max_daemons: number; label: string | null; sql: string }> {
  const join_grant = "jg_" + randomHex(16);
  const grant_id = "g_" + randomHex(8);
  const grant_hash = await sha256Hex(join_grant);
  const max_daemons = opts?.max_daemons ?? 2;
  const label = opts?.label ?? null;
  const created = Date.now();
  const sql =
    `INSERT INTO grants (grant_id, grant_hash, max_daemons, used, label, created_at, revoked_at) ` +
    `VALUES ('${grant_id}', '${grant_hash}', ${max_daemons}, 0, ${label === null ? "NULL" : `'${label.replace(/'/g, "''")}'`}, ${created}, NULL);`;
  return { grant_id, join_grant, grant_hash, max_daemons, label, sql };
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

if (import.meta.main) {
  const label = arg("--label", Bun.argv) ?? null;
  const max = Number(arg("--max-daemons", Bun.argv) ?? "2");
  const minted = await mintJoinGrant({ label, max_daemons: Number.isFinite(max) ? max : 2 });
  process.stdout.write(`grant_id=${minted.grant_id}\njoin_grant=${minted.join_grant}\n`);
  process.stdout.write(`# print once; hash only after this point\n${minted.sql}\n`);
}
