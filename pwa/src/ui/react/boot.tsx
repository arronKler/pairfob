import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { state } from "../../state";
import { Brand, Spinner } from "./chrome";

export function BootScreen() {
  return <div className="boot">
    <Brand /><Spinner />
    <p className="boot-text">{state.phase === "boot" ? t("boot.reading")
      : t("boot.connecting", { name: state.credential ? computerTitle(state.credential) : t("boot.computer") })}</p>
  </div>;
}
