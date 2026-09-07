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

* **`file://` insecure origin.** Was a real bug, already fixed. `MainActivity` serves
  assets over `https://appassets.androidplatform.net/assets/` via `shouldInterceptRequest`.
* **System permission.** `RECORD_AUDIO` is granted, "Allow only while using the app".
* **Global mic kill switch.** Checked, on.
* **Hardware.** Chrome on the same tablet recognised all four languages the same day.

### What the previous round got wrong

Three things, found by reading the code rather than the tablet:

1. **`Bridge.onError()` threw every recogniser failure away.** It set a flag and returned.
   The page had no way to learn that recognition had failed, let alone why — so every
   failure, of any cause, surfaced as "silent, no result". That symptom was never
   evidence of silence; it was the absence of a report. Fixed: failures now reach the
   page by name (`no-match`, `network`, `no-permission`, `language-unavailable`, …).

2. **`EXTRA_PREFER_OFFLINE` was set unconditionally**, so restoring `INTERNET` could not
   have fixed anything on its own. Asking for offline recognition on a device with no
   downloaded language pack does not fall back to the network — it fails. The old
   hypothesis ("no `INTERNET`, so the recogniser reaches nothing") was therefore
   incomplete: the permission was one of two locks on the same door. Fixed: offline is
   attempted first, and a failure that means "no on-device model here" retries once over
   the network. Both attempts are reported separately.

3. **A failed listen left the recogniser alive.** `onError` never released it, so after
   the first failure a live `SpeechRecognizer` held the microphone for the rest of the
   session — and anything that asked for the mic afterwards, `getUserMedia` included,
   got refused. This is a genuine, sufficient cause of `NotReadableError`, though see
   the caveat below. Fixed: the recogniser is released on every error, and the page waits
   out the handover (`micBusyFor()`) before taking the mic itself.

**Caveat, stated plainly: none of this is verified on the device.** It was all found by
reading the source. The fixes are correct in the sense that each repairs a real defect,
but whether they repair *your* symptom is unknown until the APK runs on the tablet.

The caveat matters most for `NotReadableError`. In the reproduction below, `Run the check`
opens `getUserMedia` *before* anything has started the recogniser, so on a freshly launched
app the leaked-recogniser chain cannot be the cause of that first failure. Something else
is refusing the WebView's first mic open, and the code does not say what.

### The thing that will answer it

The parent panel now runs `Bridge.micProbe()` — a native `AudioRecord` opened for 400ms —
immediately before the WebView tries. That single comparison splits the remaining
possibilities, which nothing measured so far could:

| Native probe | WebView | Means |
|---|---|---|
| opens | refused | the WebView is refusing, not the tablet — move recording to the native side |
| refused | refused | nothing in this app can open the mic; the probe's reason names why |
| opens | opens | it is fixed; the leaked recogniser was the cause |

Run that before writing any more code.

## How to reproduce in 30 seconds

Install, hold the top-left corner for 1.6s, tap **Run the check**, then tap 🎤 on the
English row and say "shoe". The panel now reports:

* the exact `getUserMedia` error name and the page origin,
* the native probe result beside it,
* the recogniser's failure by name, and whether it was the offline or online attempt.

**Save the report** (the panel's copy/save button) — it now contains every one of those.
Do not trust a browser test — the whole bug is that Chrome and the WebView differ.

If the report still does not explain it, `adb logcat | grep -i -E "speech|recogn|audio|webview"`
during a failed 🎤 tap remains the fastest route, and was unavailable throughout the
tablet-only debugging that produced the first version of this document.

## Building

Local (preferred now that there is a real machine):

    gradle wrapper --gradle-version 8.7
    ./gradlew assembleDebug
    adb install -r app/build/outputs/apk/debug/app-debug.apk

`adb logcat | grep -i -E "speech|recogn|audio|webview"` during a failed 🎤 tap is the
fastest route to the answer, and was unavailable throughout the tablet-only debugging
that produced this document.

## Repo layout

The GitHub repo `glenncain/Toddler-Polyglot` was populated by a browser upload that
flattened every file into the root, and two workflows reconstructed the tree at build
time — one of them (`apk2.yml`) also rewrote `index.html` with a python heredoc before
compiling, so the source that produced the APK was never the source in the repo. That is
all gone. The repo now holds the tree exactly as laid out above and the workflow just
builds it.

The kotlin-stdlib constraints that stop `checkDebugDuplicateClasses` failing are now in
`app/build.gradle`, where they apply. The earlier note claiming they were already there
was wrong — they were in the root `build.gradle`, which has no dependencies to constrain.

## Do not regress

* No text on the child screen.
* No streaks, points, or scores anywhere she can see.
* Misses never produce a buzzer, a red state, or a "wrong".
* The speech matcher is deliberately forgiving — roughly 45% Levenshtein tolerance plus a
  first-two-characters escape. A two-year-old saying "tutu" for *kutsu* must count. Do not
  tighten it to make tests pass.
* `index.html` stays a single file that runs in a plain browser with no bridge.
