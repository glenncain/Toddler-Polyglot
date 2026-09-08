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

## The microphone bug: fixed

Device: Lenovo TB305FU, Android API 35. Both microphone paths failed on the installed APK
while Chrome on the same tablet worked. Both now work. The device check on 2026-09-08:

    microphone: ok (peak 71%) origin=https:
    native mic: opens (peak 64%)
    listener:   com.google.android.tts mic=granted

    English:  asr=matched heard="shoe shoe shoe Shoe Show Shoe Show Shoe shoe"
    Spanish:  asr=matched heard="zapato zapato zapato zapato zapato zapato za"
    Mandarin: asr=matched heard="鞋鞋"
    Japanese: asr=silent  opened=yes

Three languages recognised, end to end. What it took, in the order the evidence forced:

1. **The errors were being thrown away.** `Bridge.onError()` set a flag and returned, so
   every failure — of any cause — reached the page as silence. Nothing could be diagnosed
   until that was fixed, and it is the reason the previous rounds went in circles.
2. **`getUserMedia` is refused by this WebView, permanently.** A native `AudioRecord`
   opened the microphone in the same process, at the same moment, with the same permission,
   while the WebView returned `NotReadableError`. Not permission, not origin, not hardware
   — the three things earlier rounds spent themselves on. Capture moved to the bridge.
3. **A failed listen used to keep the microphone.** The recogniser was never released on
   error, so the first failure held the mic for the rest of the session.
4. **`EXTRA_PREFER_OFFLINE` was set unconditionally,** so restoring `INTERNET` could never
   have fixed this on its own. Offline is tried first and falls back to the network, and a
   language with no on-device model is remembered so the fallback is paid once, not daily.

Note for the record: `com.google.android.tts` holds the microphone permission, so the
"recognition service is denied the mic" theory — the last one standing before this run —
was wrong. It was worth checking and it is now checked; the panel still reports it.

## What is left

**Japanese returns `asr=silent`: the recogniser takes the microphone and then answers with
neither a result nor an error.** The other three languages work, so this is specific to
`ja-JP` on this tablet, not a general fault.

A recogniser that never answers used to hold the microphone for as long as the app lived,
which for her means a card that never advances and no way back. There is now an
eight-second watchdog: the attempt is released and reported as `no-response`, so the panel
says what happened and the microphone comes back. That contains the symptom; it does not
explain it.

To take it further, try Japanese again on the next build. If it still returns nothing,
`adb logcat | grep -i -E "speech|recogn"` during that tap is the next step — a machine with
adb was never available during any of this debugging, and it is now the binding constraint
rather than the code.

**One caveat on the offline memory.** A language marked as having no on-device model stays
marked. If you later download the Japanese or Mandarin offline speech pack, clear the app's
storage (or the `em:asr-offline:` keys) so it tries offline again.

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
