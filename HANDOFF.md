# Handoff to Claude Code

Read this first. It is the state of the project, what has already been ruled out, and
the one open bug.

## What this is

A four-language spoken-vocabulary app for a three-year-old. Eleven minutes a day, thirty
everyday objects, English / Spanish / Mandarin / Japanese. She taps a picture, hears the
word, and says it back; the card does not advance until it hears her. Nothing is ever
marked wrong — a missed word quietly returns three cards later and again tomorrow.

Hard constraints from the original brief, none of them negotiable:

* **No text anywhere on her screen.** No menus, no scores, no timer, no streak. She cannot
  read. The only glyphs she sees are ✓ and → at the bottom edge, and those are for the
  parent sitting next to her.
* The parent screen is behind a 1.6-second press-and-hold on the top-left corner.
* Parents record the words in their own voices; synthesis is the fallback, not the default.
* Runs on an old tablet.

## Layout

    app/src/main/assets/index.html      the entire app — UI, scheduling, matching
    app/src/main/java/.../MainActivity  WebView host, https asset serving, file picker
    app/src/main/java/.../Bridge.java   native TTS, SpeechRecognizer, key-value store
    .github/workflows/build-apk.yml     builds the APK on GitHub Actions

`index.html` is byte-identical to the standalone browser build. It detects
`window.AndroidBridge` at runtime and falls back to web APIs when absent. **Keep it that
way** — do not fork it into an Android-only copy.

## The open bug

**On the installed APK, both microphone paths fail. In Chrome on the same tablet, both work.**

Device: Lenovo TB305FU, Android API 35.

| Path | Used for | APK | Chrome |
|---|---|---|---|
| Android `SpeechRecognizer` (native) | her saying words back | silent, no result | n/a |
| `getUserMedia` (WebView) | level meter, parent voice recording | `NotReadableError` | works |

Confirmed working in the APK: TTS in all four languages, the native key-value store
(`ON DEVICE`), `SpeechRecognizer.isRecognitionAvailable()` returns true.

### Already ruled out

* **`file://` insecure origin.** Was a real bug, already fixed. `MainActivity` now serves
  assets over `https://appassets.androidplatform.net/assets/` via
  `shouldInterceptRequest`. The diagnostic confirms the page origin is `https:`.
* **System permission.** `RECORD_AUDIO` is granted, "Allow only while using the app".
* **Global mic kill switch.** Checked, on.
* **Hardware.** Chrome on the same tablet recognised all four languages the same day.

### Current hypothesis, not yet tested on device

`INTERNET` was deliberately left out of the manifest to honour "run it offline". Android's
`SpeechRecognizer` needs a connection unless per-language offline speech data has been
downloaded, which this tablet probably lacks. It would start, reach nothing and return
silence — exactly what is observed. **The permission has been restored in this handoff but
never verified on the device.** Confirm or kill this hypothesis first.

That hypothesis does not explain `NotReadableError` from `getUserMedia`, which needs no
network. Two candidates there, in order of likelihood:

1. `SpeechRecognizer` and `getUserMedia` contending for the mic. `Bridge.stopAsrInternal()`
   calls `cancel()` then `destroy()`, which may not release the input device before the
   WebView asks for it. Try a delay, or route recording through a native `MediaRecorder`
   instead.
2. Some WebView builds refuse mic capture regardless of `onPermissionRequest`. If so, move
   recording to the native side entirely — the bridge already owns audio.

### How to reproduce in 30 seconds

Install, hold the top-left corner for 1.6s, tap **Run the check**, then tap 🎤 on the
English row and say "shoe". The panel reports the raw transcript and the exact error name.
Do not trust a browser test — the whole bug is that Chrome and the WebView differ.

## Building

Local (preferred now that there is a real machine):

    gradle wrapper --gradle-version 8.7
    ./gradlew assembleDebug
    adb install -r app/build/outputs/apk/debug/app-debug.apk

`adb logcat | grep -i -E "speech|recogn|audio|webview"` during a failed 🎤 tap is the
fastest route to the answer, and was unavailable throughout the tablet-only debugging
that produced this document.

## Repo warning

The GitHub repo `glenncain/Toddler-Polyglot` was populated by a browser upload that
**flattened every file into the root**, and the workflow there reconstructs the tree at
build time. It also contains stray duplicates (`build (1).gradle`, a root-level
`build-apk.yml` that does nothing, and an `index.html` predating the localStorage fix).
Prefer pushing this folder over that repo wholesale rather than reconciling the two.

Known build fix already applied: androidx pulls conflicting `kotlin-stdlib-jdk7/8`
versions, which fails `checkDebugDuplicateClasses`. Constraints pinning both to 1.8.22
are in `app/build.gradle`.

## Do not regress

* No text on the child screen.
* No streaks, points, or scores anywhere she can see.
* Misses never produce a buzzer, a red state, or a "wrong".
* The speech matcher is deliberately forgiving — roughly 45% Levenshtein tolerance plus a
  first-two-characters escape. A two-year-old saying "tutu" for *kutsu* must count. Do not
  tighten it to make tests pass.
* `index.html` stays a single file that runs in a plain browser with no bridge.
