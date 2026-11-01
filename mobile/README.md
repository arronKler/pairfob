# Pairfob mobile shell

Capacitor 8 Android shell for the existing PWA. The shell adds no screens of
its own: it bundles `pwa/dist-native` into the APK, serves it from the local
WebView origin, and points the existing screens at a relay origin.

```
pwa/src (same app) --bun run build:native--> pwa/dist-native
                                                   |
                                      cap sync android
                                                   |
                                    android/app/src/main/assets/public
```

The generated bundle and Gradle output are not committed. `pwa/dist-native` is
built from the checked-out PWA; rerun `bun run sync` after every PWA change.

## Prerequisites

- macOS or Linux with Android Studio and an emulator
- JDK 21, for example `/Applications/Android Studio.app/Contents/jbr/Contents/Home`
- Android SDK platform 36 (`android-36`) and build-tools `36.1.0`
- Bun 1.3 or newer
- `adb` from the same SDK

Create `android/local.properties` (untracked) when Gradle cannot find the SDK:

```properties
sdk.dir=/path/to/Android/sdk
```

## Build the debug APK

```sh
# macOS with Android Studio installed:
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

cd mobile
bun install
bun run build:debug
```

`build:debug` is ordered deliberately:

1. `pwa:native` runs the PWA `build:native` script into `pwa/dist-native`
2. `sync` runs `cap sync android`, copying the bundle into the Android project
3. `apk:debug` runs `./gradlew assembleDebug`

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

This build uses the production pair:

| Input | Value |
| --- | --- |
| WebView origin | `https://localhost` |
| Relay | `https://pairfob.com` |

Install and launch on the running emulator:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.pairfob.app/.MainActivity
```

## Beta release APK

Release builds are signed with a local beta key that never enters the repository:

```
android/keystore.properties        # gitignored
android/app/pairfob-beta.keystore  # gitignored
```

`keystore.properties` names the file and holds the passwords:

```properties
storeFile=pairfob-beta.keystore
storePassword=…
keyAlias=pairfob-beta
keyPassword=…
```

Back up both files: every future beta update must use the same key, and
without it Android refuses to install the update over an existing install.
When the files are absent, `assembleRelease` still builds but produces an
unsigned APK. `versionName` lives in `android/app/build.gradle`.

```sh
cd mobile
bun run build:release
```

The signed APK is
`android/app/build/outputs/apk/release/app-release.apk`. Verify it with
`$ANDROID_HOME/build-tools/36.1.0/apksigner verify --print-certs <apk>`.

## Beta updates

The app checks the self-hosted channel at
`https://dl.pairfob.com/android/beta/latest.json`. It is a separate Worker so a
publish never deploys the relay and never resets the daemons' WebSockets. The
Settings row shows the installed version and checks on foreground at most once
every six hours. A higher `versionCode` offers **Download and install**, which
sends the versioned APK to the system browser. Android's installer enforces the
same signing key and keeps app data and pairing.

Release builds require a clean source checkout. `build:release` fixes the production
origins, embeds the source commit and tree in the signed APK, and fails if source
changes during the build. Publishing reads that embedded provenance; an old APK
cannot be relabeled with the publishing checkout's commit. Keep the generated
`app-release.apk.provenance.json` beside the APK when moving it: publishing checks
its final-byte hash to reject an APK rebuilt outside the release pipeline.

Publish a built APK:

```sh
./scripts/publish-android-beta.sh --notes "What changed" --notes-zh "本次改动" --deploy
```

The script verifies the beta certificate, requires a `versionCode` higher than
every published channel, stages `latest.json` and the APK, deploys
`workers/pairfob-downloads`, and verifies the live manifest and APK hash. It
keeps the current and previous APK. A bad beta is fixed with a higher
`versionCode`, because Android refuses downgrades.

`--notes-zh` is optional. The app shows that note when its language is Chinese
and falls back to `--notes` otherwise. The stable link
`https://dl.pairfob.com/android/beta/latest.apk` redirects to the APK named in
the manifest, so the tester docs do not need a version in the URL.

Builds from before beta.9 used the relay path
`https://pairfob.com/dl/android/beta/latest.json`. `--legacy-only` points that
old channel at the staged build once more, and `--legacy-relay` publishes to
both in one run. Both deploy the relay and require `--deploy`; use them only for the transition.

The PWA side is `pwa/src/features/settings/android-update.ts` and
`android-update-view.tsx`. `UpdateBridge` installs an origin-restricted WebView
message listener before navigation. Only the `https://localhost` main frame can
read the installed version, fetch the exact download manifest or open a beta APK
on `dl.pairfob.com`. Debug builds also allow the local HTTP app origin and
loopback downloads. Unsupported WebViews receive no privileged fallback.

Run the native boundary tests on a connected emulator (the release test uses the
same signing key and preserves the existing app data):

```sh
cd android
./gradlew connectedReleaseAndroidTest -PpairfobTestBuildType=release
```

Tester instructions and known limits live in
[`site/doc/android-beta.md`](../site/doc/android-beta.md) and its Chinese version.

## Local dev relay

The dev build keeps the same app id, swaps the WebView origin to
`http://localhost`, and points at the loopback relay. It reuses the app
installation slot, so installing it replaces a production debug build.

```sh
# terminal 1: origin + fake-runtime daemon on 127.0.0.1:18786
PAIRFOB_DEV_FAKE_RUNTIME=1 ./scripts/dev-up.sh   # from the repository root
```

```sh
# terminal 2: expose the host relay to the emulator, then build
adb reverse tcp:18786 tcp:18786
cd mobile
bun run build:debug:dev
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.pairfob.app/.MainActivity
```

`build:debug:dev` defaults to `VITE_PAIRFOB_RELAY_ORIGIN=http://127.0.0.1:18786`.
Override the variable to use another loopback relay. The Android debug manifest
permits cleartext only to `127.0.0.1` and `localhost`; release has
`usesCleartextTraffic="false"` and no debug network security config.

The WebView origin also changes between the two builds, so IndexedDB (device
credentials and session state) does not carry across them. Pair again after
switching.

## What the shell handles

- `MainActivity` routes the system back gesture into WebView history when the
  WebView can go back; with no history the normal system back finishes the app.
- `windowSoftInputMode="adjustResize"` keeps the keyboard from covering the
  compose field.
- Capacitor's WebChromeClient supplies JS dialogs, the file chooser, and
  `getUserMedia` camera permission handling. Camera QR scanning is available
  when the OS grants CAMERA; **Enter pairing code** is the fallback when it is
  not.
- The PWA's service worker is not registered in native mode. The native build
  carries its own CSP meta tag (`vite.config.ts`), scoped to the configured
  relay and its WebSocket origin.
- Notices reach the system notification shade. See **Notifications** below.

## Notifications

A WebView has no Web Push, so the shell raises notices itself.
`NotifyBridge` installs an origin-restricted WebView message listener before
navigation, beside `UpdateBridge`. Only the `https://localhost` main frame can
post, cancel, or ask for permission. Debug builds also allow
`http://localhost`.

The PWA keeps the decision of when a notice is due. A visible page shows its own
attention strip and posts nothing. A hidden page that still runs follows agent
status on the existing session and posts one notice per pane through the
bridge, using the same transition rule and 30 second window as the daemon's Web
Push path. A tap opens `/pair#notify=1&d=…&pane=…`, the same deep link the
browser receives.

Two channels carry the notices. `pairfob-agents` is high importance and
vibrates. `pairfob-connection` is low importance and silent; it holds the
ongoing keep-alive notice. Notices are keyed by pane tag, so a finished turn
replaces a stale needs-you row instead of stacking.

**The keep-alive buys minutes, not background delivery.** Measured on an
emulator with notifications on and `KeepAliveService` running: a hidden page
handled a session message and raised a notice 60 seconds after backgrounding,
then handled nothing at 5 and 7 minutes while the same WebSocket stayed open.
Battery saver was off and the device was active. The process survived; the page
had stopped running. So a notice reaches the user for the first few minutes
after they leave the app and not after that. A real background notice needs a
push channel that wakes a stopped process, which is under **Not in this
scaffold**. `KeepAliveService` keeps the process warm and makes the limit
visible through its ongoing row; it does not restore page execution, and
nothing in this shell can.

`POST_NOTIFICATIONS` is requested on API 33 and later when the user turns
notifications on, not at first launch. Below API 33 only the system settings
screen can change the permission, so the row never offers a prompt it cannot
show.

## Not in this scaffold

- FCM/HMS/MiPush/OPPO/vivo/Honor/aggregator delivery, which would let a notice
  arrive with the app process gone. The shell raises local notices instead and
  reports `pushChannels: ["local"]`; a WebView without the bridge keeps the list
  empty and the row hidden.
- Play Store packaging and OTA updates.
- iOS. `NativePlatform` accepts `"ios"` but no iOS project exists here.
- Native deep-link and QR plugins. The typed pairing code path is the
  acceptance fallback.
