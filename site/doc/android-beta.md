---
title: Android beta
description: Install, update and test the Pairfob Android beta.
---

# Android beta

The Android beta bundles the Pairfob app for phones and tablets. It connects to
the agents running on your computer through `pairfob.com`. It is a sideloaded
APK, not a Play Store release. Keep the computer running and online.

## Install and pair

1. Use Android 7.0 or newer, with an up-to-date Android System WebView and browser.
2. [Install Pairfob on your computer](/install) and start its service.
3. [Download the latest beta](https://dl.pairfob.com/android/beta/latest.apk).
   The current version and its notes are in the
   [release manifest](https://dl.pairfob.com/android/beta/latest.json); past
   builds are on [GitHub Releases](https://github.com/arronKler/pairfob/releases).
4. Open the downloaded APK. If Android asks, allow installation from the browser
   you used. You can turn this permission off again after installation.
5. Open Pairfob. Run `pairfob pair` on the computer, scan the QR or enter the
   pairing code, compare the confirmation words and confirm on the computer.

The Android app carries its own copy of the web app. A change on pairfob.com
arrives with the next beta APK, not automatically.

Only use the official download host or the GitHub release linked above. The
package is `com.pairfob.app`.
The beta signing certificate SHA-256 is:

```text
1df205898f9e85ab178d280d3a7a5af5a683e5c686ac7e0df3c37057a64349dc
```

## Update without losing pairing

In **Settings**, find the Android app version and choose **Check for updates**.
When a newer version is available, **Download and install** opens the system
browser. Download the file and accept Android's update prompt. Open Pairfob
again and check that its version changed and your computer is still paired.
Do not uninstall or clear app data to update: that removes the local pairing.

The app also checks at startup and when returning to the foreground, at most
once every six hours after a successful check. Manual checks bypass that delay.
Installation is never automatic. Android checks the signing identity; the app
does not independently verify the downloaded APK's SHA-256. The release manifest
provides the hash for manual verification.

If installation fails, record the Android error, installed version and download
version. A fix ships with a higher version code; do not try to downgrade.

## What to try

- Pair, close and reopen the app, then switch between Wi-Fi and mobile data.
- Open a session, read its terminal, and send a harmless command in a test session.
- Mark a completed session read, reconnect, and check that it stays read.
- Open files and changes, attach a small non-sensitive file in a test session,
  and check the result on the computer.
- Rotate the device and try a hardware keyboard if you have one.
- Turn on notifications in Settings, send the app to the background, and check
  that a notice arrives for a session that finishes within the next fifteen
  minutes or so. A sleeping phone may wait longer; see **Current limits**.
- Update over an older beta, then confirm pairing and preferences remain.

## Current limits

- No vendor push channel (FCM or an OEM one). Notices come from a scheduled
  background check that runs about every fifteen minutes. The check wakes the
  app, loads its page offscreen, connects to your computer and raises a notice
  when a session finishes or needs you. So a notice can lag the event by up to
  that long, and Android defers the check while the phone sleeps, which can
  stretch the wait to hours. Measured on an emulator: a page hidden with the
  app kept running stopped answering within five minutes, so the check runs its
  own page instead of reusing the app's. A notice that must arrive the second
  it happens needs a push channel, and that is not in this beta.
- Mainland China network availability and vendor-specific Android behavior are
  not yet broadly validated. Android 7.0 is the minimum install version, not a
  claim that every supported Android version has been tested.
- No automatic crash reporting. Please report reproducible failures yourself.
- An old WebView that lacks the secure messaging API cannot use the in-app
  updater. Update Android System WebView, or download the APK from the official
  release manifest and install it over the existing app.

## Report a problem

[Open a beta feedback issue](https://github.com/arronKler/pairfob/issues/new?template=android-beta.yml).
Include app and daemon versions, phone model, Android/WebView version, network
type, steps, expected result and actual result. Say whether this was a fresh
install or an update. Issues are public: redact screenshots and never include
pairing codes, QR links, keys, private commands or conversation contents.

See [Privacy](/privacy) for service metadata and local data, and
[device management](/devices) to revoke a lost phone's access.
