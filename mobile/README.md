# Pairfob mobile shell

Capacitor 8 Android and iOS shells for the existing PWA. A shell adds no screens
of its own: it bundles `pwa/dist-native` into the app, serves it from the local
WebView origin, and points the existing screens at a relay origin.

```
pwa/src (same app) --bun run build:native--> pwa/dist-native
                                                   |
                                      cap sync android / ios
                                                   |
                              android/.../assets/public  ios/App/App/public
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

## Build the iOS app

The iOS project uses Swift Package Manager, not CocoaPods. `cap sync ios`
writes `App/CapApp-SPM/Package.swift`, and Xcode resolves
`capacitor-swift-pm` at the pinned Capacitor version.

Requirements:

- macOS with Xcode 15 or later and an iOS 15+ simulator
- Bun 1.3 or newer
- A network Xcode can reach GitHub from, for the first package resolution

```sh
cd mobile
bun install
bun run ios:debug
```

`ios:debug` runs the same three steps as the Android build, stopping at a
simulator build instead of Gradle:

1. `pwa:native` runs the PWA `build:native` script into `pwa/dist-native`
2. `sync:ios` runs `cap sync ios`, copying the bundle into the iOS project
3. `xcodebuild -scheme App -sdk iphonesimulator` builds a simulator app
   without release signing credentials

`bun run ios:run` builds and launches on a simulator that Capacitor picks. Open
`ios/App/App.xcodeproj` (or the `App` scheme) for the Xcode UI.

CI builds both shells: `.github/workflows/verify.yml` runs an Android debug APK
job on `ubuntu-latest` and an iOS simulator job on `macos-latest` for changes
under `mobile/`, alongside the existing web checks. Neither native job needs
release signing credentials: the Android job builds a debug APK and the iOS job
a simulator app. A local `build:debug` or `ios:debug` reproduces the same
compile.

The app is served from `capacitor://localhost`, not an `https` origin: WebKit
owns `https`, so Capacitor's scheme check rejects it as a custom scheme. The
same scheme is used by both the production and the dev build, so IndexedDB and
pairing survive switching between them on iOS.

### Device and TestFlight builds

TestFlight needs a paid Apple Developer Program membership and an App Store
Connect app record for `com.pairfob.app`. The project uses automatic signing
but ships no `DEVELOPMENT_TEAM`; open it in Xcode, select the `App` target and
pick the team, or pass `DEVELOPMENT_TEAM=<team id>` to `xcodebuild`.
`MARKETING_VERSION` is the three-part app version and
`CURRENT_PROJECT_VERSION` is the build number; raise the build number for
every upload. Archive to the App Store or a TestFlight group as usual.

Before the first upload:

- `App/PrivacyInfo.xcprivacy` must stay in the `App` target's Copy Bundle
  Resources. It declares only `NSPrivacyAccessedAPICategoryUserDefaults`
  (reason `CA92.1`) for the background-sync flag; the app does no tracking and
  collects no data. The Capacitor frameworks carry their own manifests.
- Answer App Store Connect's export-compliance question. The app encrypts pair
  and session traffic, so the answer is the developer's own export
  classification; `ITSAppUsesNonExemptEncryption` is deliberately left unset
  instead of guessed.
- Metadata: name `Pairfob`, support URL `https://pairfob.com`, privacy policy
  `https://pairfob.com/doc/privacy`, a category, a 6.9-inch iPhone screenshot
  set, an age rating, and TestFlight test information. Internal testers need
  no review; external testers need Beta App Review.

Signing identities and App Store Connect keys never enter the repository.
With an App Store Connect API key (`.p8` path, key id, issuer id):

```
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Pairfob.xcarchive \
  archive -allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY" \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

Export the archive with an `-exportOptionsPlist` whose `method` is
`app-store-connect` and `signingStyle` is `automatic`, then upload the `.ipa`
with `xcrun altool --upload-app -f build/export/App.ipa -t ios --apiKey
"$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"`. Uploads are outward-facing: upload
only a build that passed the checks above.

The shell has no self-update path. App Store and TestFlight are the only update
channels, so the Android update card is not shown on iOS.

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

On iOS the simulator shares the host's loopback, so there is no `adb reverse`
step:

```sh
cd mobile
bun run ios:debug:dev
bun run ios:run
```

`ios:debug:dev` points the bundle at `http://localhost:18786`; the ATS
`NSAllowsLocalNetworking` allowance and a `localhost` exception permit that
cleartext connection. The web origin stays `capacitor://localhost` in both
builds, so switching relays keeps the app's stored session.

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

On iOS, `PairfobBridgeViewController` is the scene's root: it keeps the window
dark behind the page, adds the notification and theme scripts before the first
document loads, and follows the document's `data-theme` with the status-bar
text colour. The system back gesture is the edge swipe; the PWA's own back
handling covers in-app navigation, and with nothing to go back to the swipe
returns to the Home screen. The keyboard is handled by WebKit's viewport
(`interactive-widget=resizes-content` in the PWA viewport tag), with the PWA's
safe-area padding keeping the compose field above it.

## Notifications

A WebView has no Web Push, so the shell raises notices itself.
`NotifyBridge` installs an origin-restricted WebView message listener before
navigation, beside `UpdateBridge`. Only the `https://localhost` main frame can
post, cancel, or ask for permission. Debug builds also allow
`http://localhost`. The iOS bridge accepts the same messages from
`capacitor://localhost` and exposes the same `window.PairfobNotify` face, so the
PWA has one client (`pwa/src/lib/native-notify.ts`).

The PWA keeps the decision of when a notice is due. A visible page shows its own
attention strip and posts nothing. A hidden page that still runs follows agent
status on the existing session and posts one notice per pane through the
bridge, using the same transition rule and 30 second window as the daemon's Web
Push path. A tap opens `/pair#notify=1&d=…&pane=…`, the same deep link the
browser receives.

**Background delivery is a scheduled job.** Measured on an emulator, a hidden
page stops running a few minutes after the app leaves the screen: one message
was handed to it at 60 seconds and ignored at five and seven minutes while the
same WebSocket stayed open with battery saver off. A foreground service keeps
the process alive and the page dead, so it buys nothing.

`NotifySyncJobService` wakes the app every fifteen minutes instead. It runs the
bundled page offscreen in a `WebView` of its own, at the app's origin through
`BundledAssets`, so the page reads the same IndexedDB session and the producer
above runs unchanged. Notices are posted at whatever moment the page reaches a
transition, not when the job started. The job holds the page for eight minutes,
so a phone that wakes on schedule checks in about every fifteen minutes. Android
defers periodic work while the screen is off and the phone is dozing, so a
dormant phone can wait hours.

Two things keep the schedule honest. `SyncBootReceiver` re-arms it after a
reboot or an app update, since both drop persisted jobs. `MainActivity` marks
the app visible from `onResume` to `onPause`, and a job that finds the app on
screen stands aside for the page the user is already looking at. `open` waits
ten seconds before building the WebView: a job can start while the activity is
still stopping, and building one there holds the main thread long enough for a
background ANR.

Notices post to `pairfob-agents`, which is high importance and vibrates, and
are keyed by pane tag, so a finished turn replaces a stale needs-you row
instead of stacking. The keep-alive channel from older builds is deleted the
first time the page checks in, since nothing posts to it now.

`POST_NOTIFICATIONS` is requested on API 33 and later when the user turns
notifications on, not at first launch. Below API 33 only the system settings
screen can change the permission, so the row never offers a prompt it cannot
show.

### iOS

`PairfobNotify` maps the same port onto `UNUserNotificationCenter`: one request
per pane tag, so a finished turn replaces a stale needs-you row, and the tap URL
travels back to the page through `ready` / `onmessage`. Permission is requested
when the user turns notifications on; a denied permission is reported as
denied, and the settings row does not prompt again.

iOS cannot keep the page running in the background, so the analogue of
`NotifySyncJobService` is `BGAppRefreshTask` (`BackgroundRefresh.swift`). A
request is submitted when notifications are turned on and re-armed at launch,
since a reboot can drop the pending request while the stored choice stays on.
When iOS runs the task, an offscreen `WKWebView` loads the bundled page at
`capacitor://localhost` through `PairfobAssetHandler`, sharing the app's data
store, and the same producer posts whatever transition it reaches. The task
holds the page for 24 seconds and completes exactly once.

This is best effort. iOS decides whether and when a refresh runs from the
user's habits and the device state, so a notice can arrive much later than the
Android job's fifteen-minute cadence, or not at all. If Background App Refresh
is off for the app, `BGTaskScheduler` refuses the request and enabling
notifications reports the failure instead of promising a wake that cannot
happen.

## Not in this scaffold

- FCM/HMS/MiPush/OPPO/vivo/Honor/aggregator delivery, which would let a notice
  arrive with the app process gone. The shell raises local notices instead and
  reports `pushChannels: ["local"]`; a WebView without the bridge keeps the list
  empty and the row hidden.
- Play Store and App Store packaging. Android has a sideloaded beta channel;
  iOS builds go out through TestFlight and Xcode archiving.
- Native deep-link and QR plugins. The typed pairing code path is the
  acceptance fallback.
- Background delivery with a guarantee. Android's job scheduler and iOS's
  background refresh both defer to the OS; neither promises an exact moment.
