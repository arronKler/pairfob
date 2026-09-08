import { beginAddComputer, forgetComputer, switchComputer } from "../../computers";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { formatDeviceAge } from "../../lib/ui-model";
import { adoptScreen } from "../../compose-drafts";
import { render } from "../../paint";
import { state } from "../../state";
import { isDesk } from "../../viewport";
import { AppNotice, BackBar, Brand, Button, Chevron } from "./chrome";
import { ManualUpdateHelp } from "./daemon-update";

function computerMeta(daemonId: string, lastSeen?: number): string {
  const current = state.phase === "live" && state.credential?.daemonId === daemonId;
  if (current) return t("computers.current");
  if (state.lastUsedDaemonId === daemonId) return t("computers.lastUsed", { when: formatDeviceAge(lastSeen) });
  return lastSeen ? t("device.lastUsed", { when: formatDeviceAge(lastSeen) }) : t("computers.neverConnected");
}

function ComputerRow({ pair }: { pair: (typeof state.computers)[number] }) {
  const current = state.phase === "live" && state.credential?.daemonId === pair.daemonId;
  const title = computerTitle(pair);
  return (
    <div className="computer-row">
      <Button className={`switch-item${current ? " on" : ""}`} onClick={() => void switchComputer(pair.daemonId)}>
        <span className="switch-main">
          <span className="switch-head">
            <span className="switch-name">{title}</span>
            {current ? <span className="pill pill-live">{t("computers.currentPill")}</span> : null}
          </span>
          <span className="switch-meta">{computerMeta(pair.daemonId, pair.lastSeen || pair.createdAt)}</span>
        </span>
        <Chevron />
      </Button>
      <Button className="computer-forget" aria-label={t("computers.forgetAria", { title })} onClick={() => void forgetComputer(pair.daemonId)}>{t("forget")}</Button>
    </div>
  );
}

function AddComputerRow() {
  return (
    <Button className="switch-item computer-add" onClick={beginAddComputer}>
      <span className="add-mark" aria-hidden="true" />
      <span className="switch-main">
        <span className="switch-head">
          <span className="switch-name">{t("settings.addComputer")}</span>
        </span>
        <span className="switch-meta">{t("computers.addHint")}</span>
      </span>
      <Chevron />
    </Button>
  );
}

export function ComputersContent({ withBack }: { withBack: boolean }) {
  return (
    <>
      {withBack ? (
        <BackBar
          title={t("computers.title")}
          onBack={() => {
            adoptScreen(state.computersFrom === "settings" ? "settings" : isDesk() && state.paneId ? "pane" : "home");
            render();
          }}
        />
      ) : (
        <>
          <Brand />
          <h1 className="prelude-title">{state.computers.length > 1 ? t("computers.pick") : t("computers.offlineTitle")}</h1>
          <p className="lede">{state.computers.length > 1 ? t("computers.multiLede") : t("computers.offlineLede")}</p>
        </>
      )}
      <AppNotice />
      <div className="computer-list">
        {state.computers.map((pair) => (
          <ComputerRow key={pair.daemonId} pair={pair} />
        ))}
      </div>
      <AddComputerRow />
      {!withBack && state.computers.length ? <ManualUpdateHelp /> : null}
    </>
  );
}

export function ComputersScreen() {
  return (
    <div className={state.phase === "live" ? "page settings-page" : "page"}>
      <ComputersContent withBack={state.phase === "live"} />
    </div>
  );
}
