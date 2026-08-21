# Eleven Minutes — Android

A WebView shell around the single-file app, with the two things a WebView cannot do
handed to the platform: speaking four languages, and hearing a three-year-old.

    com.msb.elevenminutes · minSdk 24 (Android 7.0) · targetSdk 34 · no INTERNET permission

---

## Getting the APK

**This project was not compiled where it was written.** The sandbox has no Android SDK,
no Gradle, and its egress proxy blocks `dl.google.com`, `repo1.maven.org` and
`services.gradle.org`, so no Android build can resolve a single dependency there.
Everything below is the build, ready to run somewhere that can reach Maven.

### Option A — GitHub Actions (nothing to install)

1. Push this folder to a repo.
2. Actions → **Build APK** → Run workflow → `debug`.
3. About four minutes later, download the **eleven-minutes-apk** artifact.
4. On the tablet: Settings → allow install from unknown sources, then open the APK.

For a signed release build, make a keystore once:

    keytool -genkey -v -keystore eleven.jks -keyalg RSA -keysize 2048 -validity 10000 -alias eleven
    base64 -w0 eleven.jks > eleven.b64

Add repo secrets `KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`,
then run the workflow with `release`.

### Option B — locally

    # needs JDK 17 and the Android SDK (Android Studio installs both)
    gradle wrapper --gradle-version 8.7
    ./gradlew assembleDebug
    # app/build/outputs/apk/debug/app-debug.apk

    adb install -r app/build/outputs/apk/debug/app-debug.apk

---

## What the native side does

`Bridge.java` is exposed to the page as `AndroidBridge`. The web app checks for it and
falls back to plain browser APIs when it is absent, so `app/src/main/assets/index.html`
still runs unchanged in a desktop browser.

| Why it exists | Native | Web fallback |
|---|---|---|
| `SpeechRecognition` does not exist in a WebView | `SpeechRecognizer`, `EXTRA_PREFER_OFFLINE` | `webkitSpeechRecognition` |
| `speechSynthesis` is unreliable in a WebView | `TextToSpeech` per-locale | `SpeechSynthesisUtterance` |
| No `window.storage`, and losing her progress nightly is fatal | one file per key in `filesDir/store/` | in-memory only |
| Blob downloads silently do nothing | `saveFile()` → `Android/data/.../Documents` | `<a download>` |
| `file://` is not a secure origin, so no clipboard API | `ClipboardManager` | `navigator.clipboard` |
| `<input type=file>` never opens a picker | `onShowFileChooser` + `ACTION_GET_CONTENT` | native picker |

Your own recordings still come from `MediaRecorder` inside the WebView;
`onPermissionRequest` grants it the mic.

---

## Before you hand it to her

Press and hold the **top-left corner for 1.6 seconds** to reach the parent screen, then
**Check this device**. Nothing on that panel is assumed; it is all measured here:

* **Microphone** — opens the mic for four seconds with a live level meter and reports the
  peak. A flat meter usually means a case over the mic, not a broken app.
* **Speech recogniser** — present or absent.
* **Recording your voices** — whether `MediaRecorder` exists in this WebView.
* **Keeping her progress** — writes a probe key and reads it back. If it says
  *lost on close*, the native store failed and you must export before quitting.
* **Each language, twice.** 🔊 speaks the test word through the real path she will hear,
  and you confirm out loud whether anything came out — a synthesiser that returns success
  while playing silence is the common failure, and only a human catches it. 🎤 then listens
  for you saying the word and shows the raw transcript plus whether the forgiving matcher
  would have accepted it.

Each language ends with one of: **ready**, **your voice**, **hears but did not match**,
**you tap ✓**, **record this one**, or **no sound came out**. *Copy report* puts the whole
thing on the clipboard as plain text.

**Voices.** Settings → System → Languages & input → Text-to-speech → install voice data.
Spanish and Japanese are usually available; Mandarin depends on the engine. Anything
missing, record in your own voice instead — that was the point of the original prompt.

**Offline recognition** must be downloaded per language: Settings → System →
Languages & input → Voice input → Google → Offline speech recognition. Without it, and
with no `INTERNET` permission in the manifest, the recogniser simply never fires and
you tap ✓ yourself. That is a working fallback, not a broken app.

**If you want the online recogniser**, add to `AndroidManifest.xml`:

    <uses-permission android:name="android.permission.INTERNET"/>

---

## Untested claims

Written and syntax-checked, never run on a device. The device check answers most of it
on the tablet itself. What it still cannot tell you: whether `EXTRA_PREFER_OFFLINE` is
actually honoured (it will look identical to a working online recogniser if the language
data is present), whether partial results arrive fast enough for the matcher to fire
mid-word during a real session, and whether a `MediaRecorder` data URL plays back through
`<audio>` on your Android version — record one word and press ▶ to settle that last one.

`app/src/main/assets/index.html` is byte-identical to the standalone browser file. The
page detects `AndroidBridge` at runtime, so there is one source, not two.
