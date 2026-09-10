import { t } from "../../lib/i18n";
import type { StatusTone } from "../../shared/ui/primitives";

/**
 * The herd reachability banners. Pure: the caller projects the tone with
 * `herdStatusOf`/`herdStatus`, and this only decides which banner that tone
 * earns. A demo runtime and a runtime that has exited are the two states worth
 * a persistent banner; every other tone is already carried by the status row.
 */
export function HerdBanners({ tone }: { tone: StatusTone }) {
  if (tone === "demo") return <p className="banner banner-demo">{t("chrome.demoBanner")}</p>;
  if (tone === "off") return <p className="banner banner-off">{t("chrome.herdrOffBanner")}</p>;
  return null;
}
