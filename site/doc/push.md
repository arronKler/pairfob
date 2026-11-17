---
title: Notifications
description: Computer-side sending is on by default. Devices receive alerts after permission and subscription.
---

# Notifications

Sending is enabled on the computer by default. After permission and subscription, devices are notified when an Agent **needs you** or moves from **working to done**. A waiting session stays on the record: each subscribed device is told once, then again if it is still waiting 5 minutes later and 15 minutes after that, up to three alerts. Answering it, closing it, or starting a new turn replaces the browser notice with a quiet **No longer waiting** update. Web Push requires every delivery to display a notification; native app notices can be removed instead. Opening the notification goes to that session on the correct computer, not only the home list.

Completion means exactly `working → done` and is never replayed on startup. A session that is still waiting when pairfob starts or restarts is not forgotten: devices that were never told catch up, while devices already told are not repeated.

Notification types cannot currently be selected separately: needs-you and completion alerts are subscribed together. A newer state for the same session replaces its older notification, so completion does not leave a stale needs-you alert in the tray.

Pairfob works without push: open the page or the Home Screen icon; **Needs you** cards are still emphasized.

## Computer setup

Sending is enabled by default. Pairfob creates and keeps its push signing key locally and uses `https://pairfob.com` as its default contact address. Upgrading repairs the old `mailto:operator@localhost` placeholder without changing the key or your subscriptions. Custom contact addresses are preserved.

To enable sending again after explicitly disabling it:

```sh
PAIRFOB_PUSH=1 pairfob service install
```

This saves the setting and starts the service. Reinstalling preserves push settings already in the service definition; an explicit nonempty value on this command overrides them. An ordinary `pairfob service restart` does not import variables from your shell.

An optional contact override must be a real `mailto:` or `https:` URL you control:

```sh
PAIRFOB_VAPID_SUBJECT=https://example.com/contact pairfob service install
```

Do not use a localhost contact address. Updating the contact preserves the existing signing key. The supported settings above are saved directly in the service definition; external systemd environment files are not imported by the installer.

## Subscribe on the phone

After pairing, choose **Turn on** in the notification invitation, or open **Settings → Notifications** later. Choosing **Later** dismisses the invitation for this computer; reconnecting will not show it again.

On iPhone and iPad, add Pairfob to the Home Screen first and open it from that icon. Then tap **Turn on** and accept the system permission prompt. Permission is requested only after your tap. If permission was denied, change it in the system's notification settings before trying again.

Browsers without Web Push do not offer a subscription. On older computers, update Pairfob first. If sending was explicitly disabled on the computer, Settings shows the command to enable it again.

Every paired computer can notify the same browser: each one gets its own subscription. Turn notifications on once per computer — switch to it, then open **Settings → Notifications**. If a browser cannot hold a subscription for one more computer, Pairfob says so and leaves the other computers' notifications untouched; use a separate browser profile for that computer.

See [Privacy](/privacy) for what the service and push provider handle.

## After you open a notification

You should land in the matching session. If that session is gone, you return to the list with “this session is gone”.

## Turning it off

- Phone: disable notifications for the site in system settings, or revoke this device
- Computer: run `PAIRFOB_PUSH=0 pairfob service install`. Existing subscriptions stop getting “needs you” and completion pushes

A lost device should be [unpaired](/devices), not only muted.
