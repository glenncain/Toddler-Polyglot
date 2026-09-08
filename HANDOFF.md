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

## The bug, as far as it has been taken

Device: Lenovo TB305FU, Android API 35.

Two microphone paths failed on the installed APK while Chrome on the same tablet worked.
The first is now understood and fixed. The second is narrowed to one open question.

### What the device check answered

The panel now runs a native `AudioRecord` open immediately before the WebView tries the
same thing. On the tablet, 2026-09-07:

    microphone: denied (peak 0%) error=NotReadableError origin=https:
    native mic: opens (peak 1%)
    recogniser: present  last error=no-match (online)
    English: spoke=ok asr=failed err=no-match (online) opened=yes

**The app can open the microphone. The WebView cannot.** Same process, same permission,
same moment, opposite results. That is not a permission problem, not an origin problem
and not a hardware problem — the three things the previous round spent its time on. It is
this WebView build refusing `getUserMedia`, and nothing granted from the outside will
change it.

So capture moved to the native side, which is what the previous handoff already suspected
would be needed:

* `Bridge.levelStart()` / `levelStop()` — the level meter, read from `AudioRecord` and
  pushed to the page as `__micLevel`.
* `Bridge.recStart()` / `recStop()` — the parent's recordings, via `MediaRecorder`, handed
  back as a `data:audio/mp4` URL so the page stores and plays them exactly as before.
* `getUserMedia` is still the path in a plain browser. `nativeCap` picks between them.

### What is still open

The microphone is fine. The native meter, run while a parent talked, read a **63% peak**
("hears you"), and the native probe opened at 34%. So the "mic captures silence"
hypothesis is dead — do not spend another round on it.

What remains: the recogniser takes the microphone (`opened=yes`), is handed clearly
audible audio, and returns `no-match` on **every language, including English over the
network**. Google recognising an adult saying "shoe" in en-US is not a hard problem, so
something is wrong upstream of the recognition itself.

    English:  online:no-match
    Mandarin: offline:language-not-supported/no-mic → online:no-match

The Mandarin line is the offline path behaving exactly as expected: no on-device model,
never got the microphone, retried over the network. That part works. It is the online
result that makes no sense.

### The next thing to check, and why

**Android does not do the recognising.** `SpeechRecognizer` binds to a `RecognitionService`
living in another app — usually Google's — and *that app* records the audio, under its own
microphone permission. This app's permission says nothing about its. A recogniser whose
service is denied the microphone opens, reports `onReadyForSpeech`, receives silence and
returns `no-match`, which is precisely what the tablet reports.

The panel now names that service and reads its permission: the **"Who does the listening"**
row. It is the only row that matters on the next run.

## What to do next

Install, hold the top-left corner 1.6s, **Run the check**, and read the "Who does the
listening" row.

* **"its mic denied"** → that is the bug. Grant the microphone to the named app in Android
  settings (Settings → Apps → that app → Permissions → Microphone). Nothing in this
  codebase can do it, and this app's own permission does not cover it.
* **"its mic granted"** → permission is not the answer either, and the panel has taken this
  as far as it can. `adb logcat | grep -i -E "speech|recogn|audio"` during a failed 🎤 tap
  is the next step; a real machine with adb was never available during any of the debugging
  that produced this document, and that is now the binding constraint, not the code.

The saved report carries `listener:` with the service package and its permission, plus
`attempts=` listing every recogniser attempt and whether it got the microphone.

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
