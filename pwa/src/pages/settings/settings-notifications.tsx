import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { enablePush, refreshSettings } from "../../features/settings/actions";
import {
  disableLocalNotifications, enableLocalNotifications, localNotificationsEnabled,
  localPushRevision, refreshLocalPush, subscribeLocalPush,
} from "../../features/settings/local-push";
import { t } from "../../lib/i18n";
import { messageOf } from "../../lib/notices";
import type { NativeNotificationPermission } from "../../lib/native-notify";
import { CommandLine, Fold, SetAction, SetItem } from "../../shared/ui/primitives";

/**
 * This phone's notifications, handled on the row: turn on at the trailing
 * edge, a green "on" once subscribed, and — when the computer has not enabled
 * push — the setup steps expand inside the card instead of a second dialog.
 *
 * The native shell has no Web Push. Its row asks MainActivity in place, keeps
 * the answer on the same row, and turns off through the green state it shows.
 */

export type WebNotificationRowInput = {
  channel: "web";
  loading: boolean;
  connected: boolean;
  supported: boolean;
  /** null: not read yet or unreadable. */
  pushEnabled: boolean | null;
  pushSubscribed: boolean | null;
  error: string;
};

/** The native bridge supplies its own state; the row reads it directly. */
export type NativeNotificationRowInput = { channel: "native" };

export type NotificationRowInput = WebNotificationRowInput | NativeNotificationRowInput;

const PUSH_ENV = "PAIRFOB_PUSH=1 pairfob service install";
const copyLabels = () => ({ copy: t("set.copy"), copied: t("set.copied"), failed: t("set.copyFailed") });

export function NotificationItem({ input }: { input: NotificationRowInput }) {
  return input.channel === "native" ? <LocalNotificationItem /> : <WebNotificationItem input={input} />;
}

function WebNotificationItem({ input }: { input: WebNotificationRowInput }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  let sub = t(input.pushSubscribed === true ? "settings.pushOn" : "settings.pushOff");
  let subTone: "error" | undefined;
  let trailing;
  let steps = false;
  if (input.error) {
    sub = input.error;
    subTone = "error";
    trailing = <SetAction onClick={() => void refreshSettings()}>{t("retry")}</SetAction>;
  } else if (!input.connected) {
    trailing = <span className="set-state">{t("set.needsConnection")}</span>;
  } else if (input.loading && input.pushEnabled === null) {
    trailing = <span className="skel" aria-label={t("push.loading")} />;
  } else if (!input.supported) {
    sub = t("err.pushUnsupported");
    trailing = <span className="set-state">{t("set.pushUnsupported")}</span>;
  } else if (input.pushEnabled === false) {
    sub = t("settings.pushComputerOff");
    steps = open;
    trailing = <SetAction aria-expanded={open} onClick={() => setOpen(!open)}>
      {t("set.pushHowto")}<ChevronDown className={`set-disclosure${open ? " is-open" : ""}`} size={14} aria-hidden="true" />
    </SetAction>;
  } else if (input.pushSubscribed === true) {
    trailing = <span className="set-state is-ok"><Check size={16} aria-hidden="true" />{t("set.pushOnShort")}</span>;
  } else if (input.pushEnabled === null) {
    trailing = <SetAction onClick={() => void refreshSettings()}>{t("retry")}</SetAction>;
  } else {
    trailing = <SetAction tone="fill" disabled={busy} aria-busy={busy || undefined} onClick={() => {
      setBusy(true);
      void enablePush().finally(() => setBusy(false));
    }}>{busy ? t("set.pushEnabling") : t("set.pushEnable")}</SetAction>;
  }
  return <div className="set-item-group notification-item">
    <SetItem label={t("settings.notifications")} sub={sub} subTone={subTone} trailing={trailing} />
    <Fold open={steps} lazy>
      <ol className="set-steps">
        <li>{t("set.pushStepEnv")}<CommandLine command={PUSH_ENV} labels={copyLabels()} /></li>
        <li>{t("set.pushStepBack")}</li>
      </ol>
    </Fold>
  </div>;
}

function LocalNotificationItem() {
  const [status, setStatus] = useState<{ permission: NativeNotificationPermission; keepAlive: boolean } | null>(null);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useSyncExternalStore(subscribeLocalPush, localPushRevision);
  const enabled = localNotificationsEnabled();
  useEffect(() => {
    let live = true;
    setReading(true);
    void refreshLocalPush().then((next) => {
      if (!live) return;
      setStatus(next);
      setReading(false);
    }, () => {
      if (live) setReading(false);
    });
    return () => { live = false; };
  }, [revision]);
  const reread = () => {
    void refreshLocalPush().then(setStatus, () => undefined);
  };
  const enable = () => {
    setBusy(true);
    setError("");
    void enableLocalNotifications().catch(async (failure: unknown) => {
      const next = await refreshLocalPush().catch(() => null);
      if (next) setStatus(next);
      // A denial is already explained by the row's own denied copy.
      if (next?.permission !== "denied") setError(messageOf(failure));
    }).finally(() => setBusy(false));
  };
  const disable = () => {
    setBusy(true);
    setError("");
    void disableLocalNotifications().finally(() => {
      setBusy(false);
      reread();
    });
  };
  const denied = status?.permission === "denied";
  const on = enabled && status?.permission === "granted";
  let sub = t(enabled ? "settings.pushOn" : "settings.pushOff");
  let subTone: "error" | "warn" | undefined;
  let trailing;
  if (reading && status === null) {
    trailing = <span className="skel" aria-label={t("push.loading")} />;
  } else if (denied) {
    sub = t("notify.androidDenied");
    subTone = "warn";
    trailing = <span className="set-state">{t("notify.androidDeniedState")}</span>;
  } else if (on) {
    trailing = <SetAction tone="ok" disabled={busy} aria-busy={busy || undefined}
      aria-label={t("notify.disableAria")} onClick={disable}>
      <Check size={16} aria-hidden="true" />{t("set.pushOnShort")}
    </SetAction>;
  } else {
    if (error) {
      sub = error;
      subTone = "error";
    }
    trailing = <SetAction tone="fill" disabled={busy} aria-busy={busy || undefined} onClick={enable}>
      {busy ? t("set.pushEnabling") : t("set.pushEnable")}
    </SetAction>;
  }
  return <div className="set-item-group notification-item" data-native="true">
    <SetItem label={t("settings.notifications")} sub={sub} subTone={subTone} trailing={trailing} />
    <Fold open={on} lazy>
      <div className="notification-keepalive">
        <p>{t("notify.keepAlive")}</p>
        <p>{t("notify.keepAliveOff")}</p>
      </div>
    </Fold>
  </div>;
}
