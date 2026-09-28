import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { requestBootStorageRetry } from "../../app/boot-actions";

/** Storage failure is a recoverable boot state, not a request to pair again. */
export function StorageRecovery() {
  return <section className="boot-storage-recovery" role="status">
    <p>{t("boot.storageUnavailable")}</p>
    <p>{t("boot.storageRetryHelp")}</p>
    <Button className="btn" onClick={requestBootStorageRetry}>{t("retry")}</Button>
  </section>;
}
