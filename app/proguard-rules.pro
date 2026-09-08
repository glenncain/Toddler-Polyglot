# The WebView calls these by name from JavaScript. Do not touch them.
-keepclassmembers class com.msb.elevenminutes.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
