package com.msb.elevenminutes;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Everything the web layer cannot do inside a WebView:
 *   - speak in four languages, offline, using the device's own voices
 *   - listen to a three-year-old and report what it thought it heard
 *   - remember her progress and your recordings between launches
 *
 * All @JavascriptInterface methods arrive on a background thread, so anything
 * touching TextToSpeech or SpeechRecognizer is posted to the main looper.
 */
public class Bridge {

    private final Activity act;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final File storeDir;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final Map<String, Boolean> voiceCache = new HashMap<>();

    private SpeechRecognizer asr;
    private boolean asrListening = false;
    private String asrLang = null;
    private boolean asrOffline = false;
    private boolean asrOpened = false;               // did this attempt reach the microphone
    private final Map<String, Boolean> offlineOk = new HashMap<>();
    private static final String OFFLINE_KEY = "em:asr-offline:";

    /* A recogniser that answers with neither a result nor an error keeps the microphone
       for as long as the app lives. Nothing else in here can take it back, and she would
       just be standing in front of a card that never advances. */
    private static final long ASR_MAX_MS = 8000;   // under the panel's own 9s, so this verdict wins
    private Runnable asrWatchdog;

    private Thread levelThread;
    private volatile boolean levelRun = false;
    private android.media.MediaRecorder rec;
    private File recFile;

    /* Destroying a SpeechRecognizer does not hand the microphone back the instant the
       call returns — the recognition service it was bound to lets go a moment later.
       Anything else that wants the mic, getUserMedia above all, has to wait that out. */
    private static final long SETTLE_MS = 350;
    private long micFreeAt = 0L;

    public Bridge(Activity act, WebView web) {
        this.act = act;
        this.web = web;
        this.storeDir = new File(act.getFilesDir(), "store");
        if (!storeDir.exists()) storeDir.mkdirs();
        ui.post(this::initTts);
    }

    /* ───────────── plumbing back into the page ───────────── */

    private void toJs(final String js) {
        ui.post(() -> {
            try { web.evaluateJavascript(js, null); } catch (Throwable ignored) {}
        });
    }

    private static String q(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    private static Locale locale(String tag) {
        if (tag == null) return Locale.US;
        String t = tag.toLowerCase(Locale.ROOT);
        if (t.startsWith("es")) return new Locale("es", "ES");
        if (t.startsWith("zh")) return Locale.SIMPLIFIED_CHINESE;
        if (t.startsWith("ja")) return Locale.JAPANESE;
        return Locale.US;
    }

    /* ───────────── speaking ───────────── */

    private void initTts() {
        tts = new TextToSpeech(act, status -> {
            ttsReady = (status == TextToSpeech.SUCCESS);
            if (ttsReady) {
                tts.setSpeechRate(0.72f);
                tts.setPitch(1.05f);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { toJs("window.__ttsDone && window.__ttsDone(" + id + ",true)"); }
                    @Override public void onError(String id) { toJs("window.__ttsDone && window.__ttsDone(" + id + ",false)"); }
                });
            }
            toJs("window.__ttsReady && window.__ttsReady(" + ttsReady + ")");
        });
    }

    @JavascriptInterface
    public boolean hasVoice(String langTag) {
        if (!ttsReady || tts == null) return false;
        Boolean cached = voiceCache.get(langTag);
        if (cached != null) return cached;
        int r;
        try { r = tts.isLanguageAvailable(locale(langTag)); }
        catch (Throwable t) { return false; }
        boolean ok = r == TextToSpeech.LANG_AVAILABLE
                  || r == TextToSpeech.LANG_COUNTRY_AVAILABLE
                  || r == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE;
        voiceCache.put(langTag, ok);
        return ok;
    }

    @JavascriptInterface
    public void speak(final String text, final String langTag, final int reqId) {
        ui.post(() -> {
            if (!ttsReady || tts == null) {
                toJs("window.__ttsDone && window.__ttsDone(" + reqId + ",false)");
                return;
            }
            try {
                tts.setLanguage(locale(langTag));
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, String.valueOf(reqId));
            } catch (Throwable t) {
                toJs("window.__ttsDone && window.__ttsDone(" + reqId + ",false)");
            }
        });
    }

    @JavascriptInterface
    public void shutUp() {
        ui.post(() -> { try { if (tts != null) tts.stop(); } catch (Throwable ignored) {} });
    }

    /* ───────────── listening ───────────── */

    /* What the recogniser reports when it fails is the single most useful thing this
       class knows, and it used to be dropped on the floor here. That is why a broken
       microphone looked like silence from the page and stayed unexplained for so long.
       Every failure now reaches the parent panel by name. */
    private static String errName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NETWORK:                  return "network";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:          return "network-timeout";
            case SpeechRecognizer.ERROR_AUDIO:                    return "audio";
            case SpeechRecognizer.ERROR_SERVER:                   return "server";
            case SpeechRecognizer.ERROR_CLIENT:                   return "client";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:           return "no-speech";
            case SpeechRecognizer.ERROR_NO_MATCH:                 return "no-match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:          return "busy";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "no-permission";
            // named constants for these arrived after minSdk; the values are stable
            case 10: return "too-many-requests";
            case 11: return "server-disconnected";
            case 12: return "language-not-supported";
            case 13: return "language-unavailable";
            case 14: return "cannot-check-support";
            default: return "error-" + code;
        }
    }

    /** Failures that mean there is no on-device model, as opposed to nothing being said. */
    private static boolean noOfflineModel(int code) {
        return code == SpeechRecognizer.ERROR_SERVER
            || code == SpeechRecognizer.ERROR_NETWORK
            || code == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
            || code == 12 || code == 13 || code == 14;
    }

    @JavascriptInterface
    public boolean asrAvailable() {
        try { return SpeechRecognizer.isRecognitionAvailable(act); }
        catch (Throwable t) { return false; }
    }

    @JavascriptInterface
    public void startListening(final String langTag) {
        ui.post(() -> {
            releaseAsr();
            // once a language is known to have no on-device model, stop splitting her
            // speaking window between a doomed offline attempt and the retry
            final boolean tryOffline = offlineWorthTrying(langTag);
            long wait = micBusyFor();
            if (wait > 0) ui.postDelayed(() -> begin(langTag, tryOffline), wait);
            else begin(langTag, tryOffline);
        });
    }

    /* EXTRA_PREFER_OFFLINE used to be set unconditionally, to keep her bedtime session
       off the network. On a tablet with no downloaded speech pack for a language that
       does not degrade to the online recogniser — it fails outright. So: ask for
       offline first, and if the answer is one of the "no on-device model" failures,
       come back once over the network rather than reporting silence. */
    private void begin(final String langTag, final boolean preferOffline) {
        if (!asrAvailable()) {
            toJs("window.__asrError && window.__asrError(\"unavailable\"," + preferOffline + ")");
            return;
        }
        asrLang = langTag;
        asrOffline = preferOffline;
        asrOpened = false;
        try {
            asr = SpeechRecognizer.createSpeechRecognizer(act);
            asr.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) {
                    asrOpened = true;
                    toJs("window.__asrReady && window.__asrReady(" + preferOffline + ")");
                }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float v) {}
                @Override public void onBufferReceived(byte[] b) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int a, Bundle b) {}

                @Override public void onError(int e) {
                    asrListening = false;
                    final boolean wasOffline = asrOffline;
                    final boolean hadMic = asrOpened;
                    final String lang = asrLang;
                    // let the recogniser finish this callback before it is torn down
                    ui.post(() -> {
                        releaseAsr();
                        /* Retrying over the network only makes sense when the offline
                           attempt never got off the ground. An offline attempt that took
                           the microphone and came back with no-match genuinely heard
                           nothing it recognised — running it again online just costs her
                           another four seconds of standing there. */
                        boolean noModel = !hadMic || noOfflineModel(e);
                        boolean retrying = wasOffline && noModel && lang != null;
                        // tell the page, so the panel does not sit on "listening" waiting
                        // for an attempt that is never coming
                        toJs("window.__asrError && window.__asrError(" + q(errName(e)) + ","
                             + wasOffline + "," + hadMic + "," + retrying + ")");
                        if (retrying) {
                            markOfflineDead(lang);
                            ui.postDelayed(() -> begin(lang, false), SETTLE_MS);
                        }
                    });
                }

                @Override public void onPartialResults(Bundle b) { push(b); }
                @Override public void onResults(Bundle b) { push(b); asrListening = false; }

                private void push(Bundle b) {
                    ArrayList<String> got = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (got == null || got.isEmpty()) return;
                    cancelWatchdog();          // it is alive and talking to us
                    StringBuilder all = new StringBuilder();
                    for (String s : got) all.append(' ').append(s);
                    toJs("window.__asrHeard && window.__asrHeard(" + q(all.toString()) + ")");
                }
            });

            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, langTag);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
            if (preferOffline && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            }
            asr.startListening(i);
            asrListening = true;
            cancelWatchdog();
            asrWatchdog = () -> {
                if (asr == null) return;
                releaseAsr();
                toJs("window.__asrError && window.__asrError(\"no-response\","
                     + preferOffline + ",true,false)");
            };
            ui.postDelayed(asrWatchdog, ASR_MAX_MS);
        } catch (Throwable t) {
            asrListening = false;
            releaseAsr();
            toJs("window.__asrError && window.__asrError(" + q("start-threw-" + t.getClass().getSimpleName())
                 + "," + preferOffline + ")");
        }
    }

    /* Whether a language has an on-device model is a fact about the tablet, not about
       this launch. Keeping it in memory only meant every session paid the doomed offline
       attempt again on every language — a second or two of her standing there saying a
       word into an attempt that cannot succeed, every single card. */
    private boolean offlineWorthTrying(String lang) {
        if (lang == null) return true;
        Boolean cached = offlineOk.get(lang);
        if (cached != null) return cached;
        boolean ok = !"0".equals(prefGet(OFFLINE_KEY + lang));
        offlineOk.put(lang, ok);
        return ok;
    }

    private void markOfflineDead(String lang) {
        if (lang == null) return;
        offlineOk.put(lang, false);
        try { prefSet(OFFLINE_KEY + lang, "0"); } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public void stopListening() { ui.post(this::releaseAsr); }

    /* The old version left the recogniser alive after an error, so a failed listen kept
       the microphone bound for the rest of the session and everything that asked for it
       afterwards was refused. */
    private void cancelWatchdog() {
        if (asrWatchdog != null) { ui.removeCallbacks(asrWatchdog); asrWatchdog = null; }
    }

    private void releaseAsr() {
        cancelWatchdog();
        boolean had = (asr != null);
        try { if (asr != null) { asr.cancel(); asr.destroy(); } } catch (Throwable ignored) {}
        asr = null;
        asrListening = false;
        asrLang = null;
        asrOffline = false;
        if (had) micFreeAt = System.currentTimeMillis() + SETTLE_MS;
    }

    /** Milliseconds the page should wait before asking for the microphone itself. */
    @JavascriptInterface
    public long micBusyFor() {
        long left = micFreeAt - System.currentTimeMillis();
        return left > 0 ? left : 0;
    }

    /* Opens the microphone natively for a moment and says what happened. The page
       cannot tell "this WebView will not capture audio" from "nothing on this device
       can open the microphone right now", and those two want opposite fixes. This can. */
    @JavascriptInterface
    public String micProbe() {
        AudioRecord r = null;
        try {
            if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                return "{\"ok\":false,\"why\":\"no-permission\"}";
            }
            int rate = 16000;
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO,
                                                   AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) return "{\"ok\":false,\"why\":\"no-buffer\"}";
            r = new AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO,
                                AudioFormat.ENCODING_PCM_16BIT, min * 2);
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                return "{\"ok\":false,\"why\":\"uninitialised\"}";
            }
            r.startRecording();
            if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                return "{\"ok\":false,\"why\":\"refused\"}";
            }
            short[] buf = new short[min];
            long frames = 0; int peak = 0;
            long until = System.currentTimeMillis() + 400;
            while (System.currentTimeMillis() < until) {
                int n = r.read(buf, 0, buf.length);
                if (n < 0) return "{\"ok\":false,\"why\":\"read" + n + "\"}";
                for (int k = 0; k < n; k++) { int v = Math.abs(buf[k]); if (v > peak) peak = v; }
                frames += n;
            }
            return "{\"ok\":true,\"frames\":" + frames
                 + ",\"peak\":" + String.format(Locale.US, "%.3f", peak / 32767.0) + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"why\":" + q(t.getClass().getSimpleName()) + "}";
        } finally {
            try { if (r != null) { r.stop(); r.release(); } } catch (Throwable ignored) {}
            micFreeAt = System.currentTimeMillis() + SETTLE_MS;
        }
    }

    /* ───────────── capturing audio, natively ─────────────
       This WebView refuses getUserMedia with NotReadableError while the app itself opens
       the microphone without complaint — micProbe() established that on the target
       tablet, and it is not a permission or origin problem, so no amount of granting
       fixes it. The level meter and the parent's recordings are therefore taken here and
       handed to the page as data. The web path stays in index.html for the browser build. */

    /** True when the page should use the two capture methods below instead of getUserMedia. */
    @JavascriptInterface
    public boolean nativeCapture() { return true; }

    @JavascriptInterface
    public boolean levelStart() {
        if (levelRun) return true;
        try {
            if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) return false;
        } catch (Throwable t) { return false; }

        final long wait = micBusyFor();
        levelRun = true;
        levelThread = new Thread(() -> {
            AudioRecord r = null;
            try {
                if (wait > 0) Thread.sleep(wait);
                int rate = 16000;
                int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO,
                                                       AudioFormat.ENCODING_PCM_16BIT);
                if (min <= 0) { toJs("window.__micLevel && window.__micLevel(-1)"); return; }
                r = new AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO,
                                    AudioFormat.ENCODING_PCM_16BIT, min * 2);
                if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                    toJs("window.__micLevel && window.__micLevel(-1)"); return;
                }
                r.startRecording();
                if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                    toJs("window.__micLevel && window.__micLevel(-1)"); return;
                }
                short[] buf = new short[min];      // ~80ms a read at this rate, so ~12 a second
                while (levelRun) {
                    int got = r.read(buf, 0, buf.length);
                    if (got <= 0) continue;
                    int peak = 0;
                    for (int k = 0; k < got; k++) { int v = Math.abs(buf[k]); if (v > peak) peak = v; }
                    toJs("window.__micLevel && window.__micLevel("
                         + String.format(Locale.US, "%.4f", peak / 32767.0) + ")");
                }
            } catch (Throwable t) {
                toJs("window.__micLevel && window.__micLevel(-1)");
            } finally {
                try { if (r != null) { r.stop(); r.release(); } } catch (Throwable ignored) {}
                micFreeAt = System.currentTimeMillis() + SETTLE_MS;
                levelRun = false;
            }
        }, "mic-level");
        levelThread.start();
        return true;
    }

    @JavascriptInterface
    public void levelStop() {
        levelRun = false;
        Thread t = levelThread;
        levelThread = null;
        if (t != null) { try { t.join(600); } catch (Throwable ignored) {} }
        micFreeAt = System.currentTimeMillis() + SETTLE_MS;
    }

    @JavascriptInterface
    public synchronized boolean recStart() {
        recDiscard();
        try {
            if (act.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                toJs("window.__recFail && window.__recFail(\"no-permission\")");
                return false;
            }
            long wait = micBusyFor();
            if (wait > 0) Thread.sleep(wait);

            recFile = new File(act.getCacheDir(), "rec-" + System.currentTimeMillis() + ".m4a");
            android.media.MediaRecorder m = (Build.VERSION.SDK_INT >= 31)
                ? new android.media.MediaRecorder(act)
                : new android.media.MediaRecorder();
            m.setAudioSource(MediaRecorder.AudioSource.MIC);
            m.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            m.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            m.setAudioChannels(1);
            m.setAudioSamplingRate(16000);
            m.setAudioEncodingBitRate(32000);
            m.setOutputFile(recFile.getAbsolutePath());
            m.prepare();
            m.start();
            rec = m;
            return true;
        } catch (Throwable t) {
            recDiscard();
            toJs("window.__recFail && window.__recFail(" + q(t.getClass().getSimpleName()) + ")");
            return false;
        }
    }

    /** Stops, and hands the clip back as a data URL so the page stores it exactly as before. */
    @JavascriptInterface
    public synchronized void recStop() {
        android.media.MediaRecorder m = rec;
        rec = null;
        boolean stopped = false;
        if (m != null) {
            try { m.stop(); stopped = true; } catch (Throwable ignored) {}
            try { m.reset(); m.release(); } catch (Throwable ignored) {}
        }
        micFreeAt = System.currentTimeMillis() + SETTLE_MS;

        File f = recFile;
        recFile = null;
        if (!stopped || f == null || !f.exists() || f.length() == 0) {
            if (f != null) f.delete();
            toJs("window.__recFail && window.__recFail(\"empty\")");
            return;
        }
        try {
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int read = 0;
                while (read < buf.length) {
                    int k = in.read(buf, read, buf.length - read);
                    if (k < 0) break;
                    read += k;
                }
            }
            toJs("window.__recDone && window.__recDone("
                 + q("data:audio/mp4;base64," + Base64.encodeToString(buf, Base64.NO_WRAP)) + ")");
        } catch (Throwable t) {
            toJs("window.__recFail && window.__recFail(" + q(t.getClass().getSimpleName()) + ")");
        } finally {
            f.delete();
        }
    }

    private void recDiscard() {
        android.media.MediaRecorder m = rec;
        rec = null;
        if (m != null) {
            try { m.stop(); } catch (Throwable ignored) {}
            try { m.reset(); m.release(); } catch (Throwable ignored) {}
            micFreeAt = System.currentTimeMillis() + SETTLE_MS;
        }
        if (recFile != null) { try { recFile.delete(); } catch (Throwable ignored) {} recFile = null; }
    }

    /* Android does not do the recognising itself — it binds to a RecognitionService in
       some other app, usually Google's, and that app records the audio under its own
       microphone permission. Ours being granted says nothing whatsoever about its. A
       recogniser that opens, hears a clear voice and returns no-match on every language
       looks exactly like one that is being handed silence, so name the service and say
       whether it is allowed the microphone at all. */
    @JavascriptInterface
    public String recognizerInfo() {
        String svc = null, pkg = null;
        try {
            svc = android.provider.Settings.Secure.getString(
                    act.getContentResolver(), "voice_recognition_service");
            if (svc != null) {
                android.content.ComponentName cn = android.content.ComponentName.unflattenFromString(svc);
                if (cn != null) pkg = cn.getPackageName();
            }
        } catch (Throwable ignored) {}

        String micPerm = "?";
        if (pkg != null) {
            try {
                micPerm = act.getPackageManager()
                        .checkPermission(Manifest.permission.RECORD_AUDIO, pkg)
                            == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
            } catch (Throwable ignored) {}
        }
        return "{\"service\":" + q(svc == null ? "none" : svc)
             + ",\"package\":" + q(pkg == null ? "?" : pkg)
             + ",\"mic\":" + q(micPerm)
             + ",\"available\":" + asrAvailable() + "}";
    }

    /* ───────────── remembering ───────────── */

    private File fileFor(String key) {
        String safe = Base64.encodeToString(key.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new File(storeDir, safe + ".txt");
    }

    @JavascriptInterface
    public String prefGet(String key) {
        try {
            File f = fileFor(key);
            if (!f.exists()) return null;
            byte[] buf = new byte[(int) f.length()];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int read = 0;
                while (read < buf.length) {
                    int n = in.read(buf, read, buf.length - read);
                    if (n < 0) break;
                    read += n;
                }
            }
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Throwable t) { return null; }
    }

    @JavascriptInterface
    public boolean prefSet(String key, String value) {
        try (FileOutputStream out = new FileOutputStream(fileFor(key))) {
            out.write(value.getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Throwable t) { return false; }
    }

    @JavascriptInterface
    public String prefKeys(String prefix) {
        StringBuilder sb = new StringBuilder("[");
        File[] all = storeDir.listFiles();
        boolean first = true;
        if (all != null) {
            for (File f : all) {
                String name = f.getName();
                if (!name.endsWith(".txt")) continue;
                try {
                    String key = new String(Base64.decode(name.substring(0, name.length() - 4),
                            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
                    if (prefix != null && !key.startsWith(prefix)) continue;
                    if (!first) sb.append(',');
                    sb.append(q(key));
                    first = false;
                } catch (Throwable ignored) {}
            }
        }
        return sb.append(']').toString();
    }

    @JavascriptInterface
    public void prefClear() {
        File[] all = storeDir.listFiles();
        if (all != null) for (File f : all) { try { f.delete(); } catch (Throwable ignored) {} }
    }

    /* ───────────── getting things out of the app ───────────── */

    /** Blob downloads do nothing in a WebView, so the page hands files here instead. */
    @JavascriptInterface
    public String saveFile(String name, String text) {
        try {
            File dir = act.getExternalFilesDir(android.os.Environment.DIRECTORY_DOCUMENTS);
            if (dir == null) dir = act.getFilesDir();
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
            return f.getAbsolutePath();
        } catch (Throwable t) { return null; }
    }

    /** file:// is not a secure origin, so navigator.clipboard is missing. */
    @JavascriptInterface
    public boolean copyToClipboard(final String text) {
        try {
            ui.post(() -> {
                android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) act.getSystemService(Activity.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Eleven Minutes", text));
            });
            return true;
        } catch (Throwable t) { return false; }
    }

    /* ───────────── what this particular tablet can actually do ───────────── */

    @JavascriptInterface
    public String capabilities() {
        return "{\"platform\":\"android\""
             + ",\"api\":" + Build.VERSION.SDK_INT
             + ",\"device\":" + q(Build.MANUFACTURER + " " + Build.MODEL)
             + ",\"tts\":" + ttsReady
             + ",\"asr\":" + asrAvailable()
             + ",\"voices\":{"
             + "\"en\":" + hasVoice("en-US") + ",\"es\":" + hasVoice("es-ES")
             + ",\"zh\":" + hasVoice("zh-CN") + ",\"ja\":" + hasVoice("ja-JP")
             + "}}";
    }

    public void release() {
        releaseAsr();
        levelStop();
        recDiscard();
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Throwable ignored) {}
        tts = null;
    }
}
