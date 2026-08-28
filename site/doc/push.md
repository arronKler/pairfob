---
title: Notifications
description: Off by default. After the computer enables push, the phone can receive needs-you and task-completion alerts.
---

# Notifications

Off by default. When enabled, subscribed devices are notified when an Agent **needs you** or moves from **working to done**. Opening the notification goes to that session on the correct computer, not only the home list.

Completion means exactly `working → done`. Starting pairfobd does not replay notifications for sessions that were already waiting or done.

Notification types cannot currently be selected separately: needs-you and completion alerts are subscribed together. A newer state for the same session replaces its older notification, so completion does not leave a stale needs-you alert in the tray.

Pairfob works without push: open the page or the Home Screen icon; **等你** cards are still emphasized.

## Enable on the computer

In the environment that starts `pairfobd`:

```sh
PAIRFOB_PUSH=1
PAIRFOB_VAPID_SUBJECT=mailto:you@example.com
```

`PAIRFOB_VAPID_SUBJECT` must be a `mailto:` or `https:` URL you control (Web Push / RFC 8292). Do not invent an address you do not own.

The installer-created user service **does not** pick these up from your current shell. Write them into the LaunchAgent / systemd environment, then:

```sh
pairfobd service restart
```

On macOS, add `EnvironmentVariables` to `~/Library/LaunchAgents/com.pairfob.pairfobd.plist`. On Linux, systemd --user `Environment=`. Restart after the change.

The first time push is enabled, the daemon writes `vapid.json` (`0600`) into the state directory. Treat it as a private key.

## Subscribe on the phone

1. The computer already has `PAIRFOB_PUSH=1` and the service is up
2. Pairfob → **设置** → **通知**
3. Tap **打开通知** when it is enabled
4. The browser asks for system permission once

If the computer has not enabled push, the button reads **电脑端未开启**, with a short setup note. Browsers without Web Notifications say so; they do not fake a subscription.

**设置** shows the subscription count for this device.

## After you open a notification

You should land in the matching pane. If that session is gone, you return to the list with “this session is gone”.

## Delivery rules

Push delivery refuses:

- Endpoints that resolve to loopback, private, link-local, unspecified, or multicast addresses
- Redirects that would take you outside the allowed range

That avoids leaking local network location to an untrusted push URL. Ordinary public push services used by browsers pass.

## Turning it off

- Phone: disable notifications for the site in system settings, or revoke this device
- Computer: drop `PAIRFOB_PUSH=1` and restart the service. Existing subscriptions stop getting “needs you” and completion pushes

A lost device should be [unpaired](/devices), not only muted.
