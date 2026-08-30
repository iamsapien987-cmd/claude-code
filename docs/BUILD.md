# Building the APK

The app is one self-contained HTML file wrapped in a thin native shell. That
means there is almost nothing to compile, and the build is about as simple as
an Android build gets.

> **This APK has not been compiled or run on a device.** The project was
> developed in an environment with no Android SDK and no route to
> `dl.google.com`, so the Kotlin has been reviewed and the resources and
> manifest validated, but nothing here has been through `aapt`, the Kotlin
> compiler, or a real phone. Expect to fix something on the first build. The
> web layer, by contrast, is verified: `tools/verify-bundle.mjs` loads the
> built page in a real browser engine on every change.

## 1. Build the web bundle first

```bash
npm install          # only needed for the headless render checks
node tools/build.mjs
```

This writes `dist/candle.html` **and copies it into
`android/app/src/main/assets/`**, so the APK can never ship a stale copy. Run
it again after any change to `src/`.

You can open `dist/candle.html` directly in any browser, including on your
phone — email it to yourself or drop it in Drive. It needs no server and no
network.

## 2. Build it

The Gradle wrapper is committed, so from a terminal:

```bash
cd android
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`.

The first run downloads Gradle and the Android Gradle Plugin, which needs
`services.gradle.org` and `dl.google.com` to be reachable. If your network
blocks either, see the troubleshooting section below.

## 3. Or open it in Android Studio

Open **Android Studio** → *Open* → select the `android/` folder (not the
repository root). Let it sync.

## 4. Run it

Plug in a phone with USB debugging on, or start an emulator, and press Run.

To get an installable file instead: *Build → Build Bundle(s) / APK(s) → Build
APK(s)*. The debug APK lands in
`android/app/build/outputs/apk/debug/app-debug.apk`. You can send that to
yourself and install it directly (you'll need "install unknown apps" enabled
for whichever app you open it from).

---

## If Gradle won't sync

This is where the earlier attempt at this project stalled, with

```
java.net.SocketTimeoutException: Connect timed out
```

That error is not about your code. Android Studio is trying to download Gradle
itself from `services.gradle.org` and the connection is failing. In rough
order of how often they work:

1. **Use a phone hotspot.** Some ISPs throttle or block developer download
   hosts. Tether the laptop to your phone and hit *Try Again*. Once the sync
   completes the files are cached and you can switch back.

2. **Increase the timeout.** `android/gradle/wrapper/gradle-wrapper.properties`
   already sets `networkTimeout=60000`. Raise it further if the connection is
   slow rather than blocked.

3. **Download Gradle by hand.** Check which version
   `gradle-wrapper.properties` asks for (currently **8.11.1**), fetch
   `gradle-8.11.1-bin.zip` from <https://services.gradle.org/distributions/> in a
   normal browser, unzip it somewhere permanent, then in Android Studio go to
   *Settings → Build, Execution, Deployment → Build Tools → Gradle*, set
   **Use Gradle from: Specified location**, and point it at that folder.

4. **Turn off the VPN, or turn one on.** Either can be the thing that fixes it,
   depending on which side is blocking.

Do **not** change `https` to `http` in the distribution URL. It is sometimes
suggested, and it does sometimes work, but it downloads your build toolchain
over an unauthenticated connection — which is not a trade worth making. Option
3 above solves the same problem safely.

### Other sync failures

- **"SDK location not found"** — Android Studio writes `local.properties` on
  first open. If it is missing, add `sdk.dir=/path/to/Android/sdk`.
- **Java version** — the project builds against JDK 17, which recent Android
  Studio bundles. *Settings → Build Tools → Gradle → Gradle JDK* → pick 17.

---

## Before you sideload the debug APK

The APK CI produces is a **debug** build. That is the right thing for putting
on your own phone — it is signed with Android's public debug key so it
installs without any keystore setup — but understand what it means:

- It is marked debuggable, so anyone with USB debugging access to the phone
  can attach a debugger and inspect it. Do not treat it as hardened.
- WebView remote debugging is on, for the same reason.
- Its application ID ends in `.debug`, so it installs alongside a release
  build rather than conflicting with it.

None of that is a risk on your own device. All of it disqualifies the build
from Play, which rejects debuggable uploads outright.

## Publishing to Google Play

The app is deliberately close to the simplest case Play review has to handle.

**Permissions.** Exactly one: `RECORD_AUDIO`, and it is requested only when
the user taps the microphone button, never at launch. It is used to detect the
rush of air when you blow at the phone and for nothing else. Audio is analysed
in the page and never recorded, stored, or transmitted. `VIBRATE` is also
declared, which requires no user grant.

There is **no `INTERNET` permission**, so the app cannot phone home even by
accident. That is worth stating in the listing.

Brightness is set on the app's own window rather than through
`Settings.System`, so `WRITE_SETTINGS` — which does draw review attention — is
not needed. Android restores the user's brightness when they leave.

**Data safety form.** No data collected, no data shared, no data types at all.
Microphone audio is processed on-device transiently and never leaves it.

**You still need a privacy policy URL.** Play requires one even for an app
that collects nothing. A single page saying so is enough.

**Target API level.** `targetSdk` is 36. Play requires new apps to target
within about a year of the latest Android release, and the exact floor moves
every August — check the current requirement in the Play Console before you
submit, because a target that is too low is rejected at upload.

**Signing.** No signing configuration is committed, deliberately: an upload
key must never live in a repository. Create one with *Build → Generate Signed
Bundle / APK* in Android Studio and keep it somewhere safe — losing it means
you can never update the app again. Prefer an *Android App Bundle* (`.aab`)
for the Play upload; APK is for sideloading.

**Version.** Bump `versionCode` for every upload; Play refuses a duplicate.

**Privacy policy.** [PRIVACY.md](../PRIVACY.md) is written and accurate to
what the code does. Play needs it at a public URL — GitHub Pages or a gist is
enough.

**Data safety form.** No data collected, no data shared. Declare the
microphone as used for app functionality, processed on-device, not collected.

CI builds the release variant on every push and fails if it comes out
debuggable, so that particular rejection cannot reach the console.

---

## How the shell works

`MainActivity.kt` is the whole native layer. Three things it does that the web
page cannot do for itself:

- **Keeps the screen awake** (`FLAG_KEEP_SCREEN_ON`), because a candle that
  needs tapping is not a candle.
- **Drives the backlight** from the flame's brightness, through a small
  JavaScript bridge (`window.CandleHost.setBrightness`). In a plain browser
  the bridge is absent and the app just skips it.
- **Hands over the microphone** when the page asks, requesting the Android
  permission at that moment.

The page is served from `https://appassets.androidplatform.net/` via
`WebViewAssetLoader`, not from a `file://` URL. That is deliberate:
`getUserMedia` only runs in a secure context, so the blow-out would not work
from `file://`. No network is involved — the loader maps that origin onto the
`assets/` folder.
