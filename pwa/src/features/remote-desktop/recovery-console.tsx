import { useState, useSyncExternalStore } from "react";
import { computerTitle } from "../../lib/computer-catalog";
import { relayURL } from "../../lib/runtime-config";
import { lang, t } from "../../lib/i18n";
import type { PairResult } from "../../lib/protocol/client";
import { consoleURL, forgetConsole, readConsole, saveConsole } from "../../lib/recovery-console";
import { useComputers } from "../computers/hooks";
import "./recovery-console.scss";

function followConsole(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("pairfob-recovery-change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("pairfob-recovery-change", listener);
  };
}

function ConsoleForHost({ pair }: { pair: PairResult }) {
  const saved = useSyncExternalStore(followConsole, () => readConsole(pair));
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  function update(remove: boolean) {
    const value = draft ?? saved;
    if (!remove && !consoleURL(value)) { setError(t("recovery.invalid")); return; }
    try {
      if (remove) forgetConsole(pair.daemonId);
      else saveConsole(pair, value);
    } catch { setError(t("recovery.storage")); return; }
    setDraft(null);
    setError("");
    window.dispatchEvent(new Event("pairfob-recovery-change"));
  }
  return <div className="recovery-host">
    {saved && <a className="text-link" target="_blank" rel="noopener noreferrer" href={saved}>
      {t("recovery.open", { host: new URL(saved).host })}
    </a>}
    <form onSubmit={event => { event.preventDefault(); update(false); }} noValidate>
      <label>{t("recovery.url")}
        <input type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false}
          value={draft ?? saved} onChange={event => { setDraft(event.target.value); setError(""); }}
          aria-invalid={Boolean(error)} placeholder="https://console.example.net/" />
      </label>
      <button type="submit" className="set-action" disabled={draft === null}>{t("recovery.save")}</button>
      {saved && <button type="button" className="set-action" onClick={() => update(true)}>{t("recovery.remove")}</button>}
      {error && <small role="alert">{error}</small>}
    </form>
    <small>{t("recovery.return")}</small>
  </div>;
}

export function RecoveryConsole({ all = false }: { all?: boolean }) {
  const { credential, computers } = useComputers();
  const [selected, setSelected] = useState("");
  const pair = (all && computers.find(item => item.daemonId === selected)) || credential || computers[0];
  if (!pair) return null;
  return <details className="recovery-console">
    <summary>{t("recovery.title")}</summary>
    {all && computers.length > 1 && <label>{t("recovery.computer")}
      <select value={pair.daemonId} onChange={event => setSelected(event.target.value)}>
        {computers.map(item => <option key={item.daemonId} value={item.daemonId}>{computerTitle(item)}</option>)}
      </select>
    </label>}
    <p>{t("recovery.hint", { host: computerTitle(pair) })}</p>
    <a className="text-link" href={relayURL(`/doc/${lang() === "zh" ? "zh/" : ""}mac-recovery`)} target="_blank" rel="noopener noreferrer">{t("recovery.guide")}</a>
    <ConsoleForHost key={pair.daemonId + "/" + pair.deviceId} pair={pair} />
  </details>;
}
