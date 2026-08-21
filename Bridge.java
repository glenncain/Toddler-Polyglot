package com.msb.elevenminutes;

import android.app.Activity;
import android.content.Intent;
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

    @JavascriptInterface
    public boolean asrAvailable() {
        try { return SpeechRecognizer.isRecognitionAvailable(act); }
        catch (Throwable t) { return false; }
    }

    @JavascriptInterface
    public void startListening(final String langTag) {
        ui.post(() -> {
            stopAsrInternal();
            if (!asrAvailable()) return;
            try {
                asr = SpeechRecognizer.createSpeechRecognizer(act);
                asr.setRecognitionListener(new RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle b) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float v) {}
                    @Override public void onBufferReceived(byte[] b) {}
                    @Override public void onEndOfSpeech() {}
                    @Override public void onError(int e) { asrListening = false; }
                    @Override public void onEvent(int a, Bundle b) {}

                    @Override public void onPartialResults(Bundle b) { push(b); }
                    @Override public void onResults(Bundle b) { push(b); asrListening = false; }

                    private void push(Bundle b) {
                        ArrayList<String> got = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        if (got == null || got.isEmpty()) return;
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
                // she is two rooms from a router at bedtime; keep it on-device where possible
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                }
                asr.startListening(i);
                asrListening = true;
            } catch (Throwable ignored) { asrListening = false; }
        });
    }

    @JavascriptInterface
    public void stopListening() { ui.post(this::stopAsrInternal); }

    private void stopAsrInternal() {
        try {
            if (asr != null) { asr.cancel(); asr.destroy(); }
        } catch (Throwable ignored) {}
        asr = null;
        asrListening = false;
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
        stopAsrInternal();
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Throwable ignored) {}
        tts = null;
    }
}
