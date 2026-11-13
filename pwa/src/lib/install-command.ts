/**
 * The one-line installer command shown on the connect page.
 *
 * The installer is served by the relay that serves this app, so a self-hosted
 * relay must hand out its own URL and enroll against itself. The official
 * instance keeps the short canonical command users already know.
 */

const OFFICIAL_RELAY_ORIGIN = "https://pairfob.com";

export function installCommandFor(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const command = `curl -fsSL ${base}/install.sh | sh`;
  return base === OFFICIAL_RELAY_ORIGIN ? command : `${command} -s -- --origin ${base}`;
}
