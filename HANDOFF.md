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
    tools/matcher-check.mjs             pins the speech matcher, loose parts included
    tools/session-check.mjs             pins her card flow against the two faults below

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

## Japanese: heard correctly, rejected by the word list

The 2026-09-08 15:45 check closed this one too:

    Japanese: asr=heard opened=yes heard="靴 普通"  → hears, did not match

靴 is *kutsu*. The recogniser had it right and the matcher threw it away, because the
Japanese entries only ever held kana and romaji — `["くつ","kutsu"]` — while ja-JP returns
**kanji**. Mandarin never hit this only because its data was already hanzi.

The matcher itself is untouched. Each Japanese word now carries its other spellings in a
third slot, and `heard()` tries those too:

    ["くつ","kutsu",["靴"]]

Kana and romaji still count, so nothing that worked before stops working. Katakana
loanwords (コップ, ドア, ボール, ミルク, バナナ, ベッド, スプーン, パン) were already
returned as katakana and were left alone.

`tools/matcher-check.mjs` pins this, the four device transcripts, and the loose behaviour
the brief insists on — "tutu" for *kutsu* is a test case, so nobody can tighten the matcher
to make something else pass without the run going red. `node tools/matcher-check.mjs` from
the repo root; needs playwright.

## Two faults found in real use

Both reported from an actual session, not from the panel, and both fixed. They are the
kind that only show up when someone is using it properly, so `tools/session-check.mjs`
pins them.

**Cards advanced on their own.** The page keeps exactly one callback slot for a recognised
transcript. A recogniser being torn down can still push a result, so the previous card's
transcript arrived after the next card was on screen and was judged against the *new*
word — by a matcher that is deliberately forgiving, so it often passed. She got credit for
a word she never said, and the card moved on without her.

Every listen is now stamped with a number by the bridge, and the page ignores any result
not carrying the number it asked for.

**The microphone went dead in the middle of a card.** Nothing in her session handled a
recogniser that stopped listening after starting — it timed out, the device was busy, it
gave up — and the eight-second watchdog added earlier in this handoff made it worse by
releasing the recogniser at eight seconds while the card waits nineteen. So between those
two, the ear was lit and nothing was listening.

The card is meant not to advance until it hears her, so a dead recogniser is now put back
while the same card is still on screen, up to six times, and the ear goes out if it truly
cannot listen rather than lying about it.

## A review pass, and what it turned up

Two passes over the whole thing after the faults above. Five more, in the order they
matter. `tools/session-check.mjs` pins the first three.

**The bottom edge of her screen advanced the card on any touch.** `#hands` is
`left:0;right:0;bottom:0` with two `flex:1` buttons 74px tall — so the entire bottom strip
was ✓ on the left half and → on the right, and a resting palm marked a word said and moved
her on. These are meant for the parent sitting next to her; they now want a deliberate
press (`HOLD_MS`, 420ms) rather than a brush. Revert by pointing `parentOnly` back at
`onclick` if it gets in the way.

**Tapping the picture while the app was speaking shut the microphone for six seconds.**
Android speaks with `QUEUE_FLUSH`, so a second utterance drops the one in flight and the
dropped one never reports done. `say()` then sat on its six-second timeout, and `heard0`
stopped one line before opening the ear. Measured against the previous build: 6813ms to
open the ear, against 1083ms now. This is the "it sometimes does not turn on the mic right
after pressing the picture" from real use.

**The app could hear itself and give her the tick for it.** The seven-second repeat and
the tap-to-replay both spoke the word while the recogniser was listening. The microphone
picked up the tablet, the matcher agreed the word had been said, and the card advanced —
marking a word learned that she had never once said aloud. Speaking now stops the
recogniser and restarts it afterwards.

**An interrupted recording never settled its promise.** `playClip` paused the previous clip
without resolving it, so whatever awaited it waited forever. This one only bites once there
are parent recordings, which is why it had not shown up yet.

**The grown-up page covered her session without stopping it.** `openParent()` only added a
CSS class. Behind the panel the card kept its timers, kept speaking the word out loud, and
kept the microphone open — listening to the two of you talk over the top of it, and
competing with the panel's own microphone tests for the device. Opening the panel now
pauses the session and closing it resumes the same card, with the time spent in there
given back rather than counted against her eleven minutes.

**A second session in one day counted as a second day**, inflating `S.day` and skewing which
words came back for review. And returning from another app left the card with a lit ear and
no recogniser, because Android stops it on pause and nothing restarted it.

## What has not been tested

Everything above was measured on the tablet, by an adult, through the parent panel. **None
of it has been in front of the child**, and the parent voice recordings have never been
exercised beyond a round-trip against a mock bridge. That is the next real test, and it is
not one this document can do anything about.

Two known loose ends:

* **The offline memory is sticky.** A language marked as having no on-device model stays
  marked, across launches, by design. If you later install the Japanese or Mandarin offline
  speech pack, clear the app's storage (or the `em:asr-offline:` keys) so it tries offline
  again.
* **The recogniser can still answer with nothing at all.** An eight-second watchdog
  releases it and reports `no-response`, so a card cannot wedge, but if that starts showing
  up often, `adb logcat | grep -i -E "speech|recogn"` during the tap is the way in. A
  machine with adb was never available during any of this debugging.

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
