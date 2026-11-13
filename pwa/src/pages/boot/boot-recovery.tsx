import { t, type CopyKey } from "../../lib/i18n";
import { relayHost } from "../../lib/runtime-config";
import { Button } from "../../shared/ui/primitives";
import { requestBootPairAnyway, requestBootRetry } from "../../app/boot-actions";
import type { BootBlock } from "../../features/connection/connection-store";

const COPY: Record<BootBlock, { title: CopyKey; help: CopyKey }> = {
  assets: { title: "boot.assetsUnavailable", help: "boot.assetsReloadHelp" },
  storage: { title: "boot.storageUnavailable", help: "boot.storageRetryHelp" },
  origin: { title: "boot.originUnavailable", help: "boot.originRetryHelp" },
  offline: { title: "boot.offline", help: "boot.offlineHelp" },
};

/**
 * A held boot is a recoverable state, not a request to pair again. Only an
 * unreadable catalog offers pairing, as the reader's explicit choice.
 */
export function BootRecovery({ block, reload = () => location.reload() }: { block: BootBlock; reload?: () => void }) {
  const copy = COPY[block];
  return <section className="boot-recovery" role="status" data-block={block}>
    <p>{t(copy.title, { relay: relayHost() })}</p>
    <p>{t(copy.help)}</p>
    <Button className="btn" onClick={block === "assets" ? reload : requestBootRetry}>
      {t(block === "assets" ? "update.reload" : "retry")}
    </Button>
    {block === "storage"
      ? <Button className="text-link boot-pair-anyway" onClick={requestBootPairAnyway}>{t("boot.pairAnyway")}</Button>
      : null}
  </section>;
}
