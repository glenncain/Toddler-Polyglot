package com.msb.elevenminutes;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private static final int REQ_MIC = 41;

    private WebView web;
    private Bridge bridge;
    private long lastBack = 0;

    private ValueCallback<Uri[]> filePicked;
    private final ActivityResultLauncher<Intent> pickFile =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (filePicked == null) return;
            Uri uri = (result.getData() != null) ? result.getData().getData() : null;
            filePicked.onReceiveValue(uri != null ? new Uri[]{ uri } : null);
            filePicked = null;
        });

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);                    // her layout must not follow system font scaling
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(false);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePicked != null) filePicked.onReceiveValue(null);
                filePicked = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    pickFile.launch(i);
                    return true;
                } catch (Throwable t) {
                    filePicked = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    for (String r : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                            request.grant(new String[]{ PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                            return;
                        }
                    }
                    request.deny();
                });
            }
        });

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        web.setBackgroundColor(0xFF171526);
        web.loadUrl("file:///android_asset/index.html");

        askMic();
        immersive();

        // a toddler will find the back gesture within about nine seconds
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                long now = System.currentTimeMillis();
                if (now - lastBack < 2200) { finish(); }
                else {
                    lastBack = now;
                    Toast.makeText(MainActivity.this, "Press back again to close", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private void askMic() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO }, REQ_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, @NonNull String[] perms, @NonNull int[] grants) {
        super.onRequestPermissionsResult(code, perms, grants);
        if (code == REQ_MIC && web != null) {
            boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
            web.evaluateJavascript("window.__micGranted && window.__micGranted(" + ok + ")", null);
        }
    }

    private void immersive() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_FULLSCREEN
          | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) immersive();
    }

    @Override protected void onPause() {
        super.onPause();
        if (bridge != null) { bridge.shutUp(); bridge.stopListening(); }
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.release();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
