package io.github.reastep3.lolsoundquiz;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;

/**
 * The whole app: one WebView showing the quiz site that is packed inside the APK.
 *
 * <p>The site's files, Riot's champion data and every sound live in {@code assets/www}
 * (written by {@code tools/offline/build.mjs}). They are served to the WebView from a
 * made-up https address, so the page runs exactly as it does on the web, with nothing
 * fetched from the network. Only playing with friends and the global leaderboard go online.
 */
public final class MainActivity extends Activity {

    // Google reserves this domain for apps to serve their own files from. It never resolves
    // on the real internet, so a page "from" it can only be a file in this APK. Using https
    // gives the page a secure origin, which JavaScript modules and the clipboard require.
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final String ASSET_ROOT = "www";
    private static final int BACKGROUND = 0xFF060B16;   // the page's own background colour

    private WebView web;
    private ConnectivityManager connectivity;
    private final OnBackInvokedCallback back = this::onBack;

    private final ConnectivityManager.NetworkCallback network = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network n) {
            tellPage(true);
        }

        @Override
        public void onLost(Network n) {
            tellPage(false);
        }
    };

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);   // volume keys always mean "the game's sound"

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(BACKGROUND);
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        frame.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);

        // Android draws apps edge to edge. Keep the page clear of the status bar, the camera
        // cut-out, the gesture bar and the keyboard; the frame's colour shows behind them.
        getWindow().setDecorFitsSystemWindows(false);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsets.CONSUMED;
        });
        WindowInsetsController bars = getWindow().getInsetsController();
        if (bars != null) {
            // Dark background, so light status and navigation icons.
            bars.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                     // settings and personal bests
        settings.setMediaPlaybackRequiresUserGesture(false);     // each question's sound starts by itself
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setSupportZoom(false);
        web.setWebViewClient(new Pages());

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);        // debug builds only
        }

        connectivity = getSystemService(ConnectivityManager.class);
        web.setNetworkAvailable(isOnline());
        connectivity.registerDefaultNetworkCallback(network);

        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, back);

        web.loadUrl(START);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        // Marks the page hidden, which is the page's cue to stop any sound.
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(back);
        connectivity.unregisterNetworkCallback(network);
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }

    /** Back button or gesture: the page decides. With nothing to go back to, step aside. */
    private void onBack() {
        web.evaluateJavascript(
                "(function(){try{return !!(window.lsq&&window.lsq.back&&window.lsq.back())}catch(e){return false}})()",
                used -> {
                    if (!"true".equals(used)) moveTaskToBack(true);
                });
    }

    private boolean isOnline() {
        Network active = connectivity.getActiveNetwork();
        NetworkCapabilities caps = active == null ? null : connectivity.getNetworkCapabilities(active);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    /** Keeps the page's navigator.onLine honest. Network callbacks arrive on another thread. */
    private void tellPage(boolean online) {
        runOnUiThread(() -> {
            if (web != null && !isDestroyed()) web.setNetworkAvailable(online);
        });
    }

    private final class Pages extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost())) return null;        // the game server: a real request
            return asset(url.getPath());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            // Any other page belongs in the browser, never inside the app.
            if ("https".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // No browser installed: nothing sensible to do.
                }
            }
            return true;
        }
    }

    /** One file from assets/www, or a 404 so the page can tell "not in the bundle" apart. */
    private WebResourceResponse asset(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (!path.contains("..")) {
            try {
                InputStream in = getAssets().open(ASSET_ROOT + path);
                String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                return new WebResourceResponse(mimeType(ext), isText(ext) ? "utf-8" : null, in);
            } catch (IOException missing) {
                // Fall through to the 404.
            }
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private static boolean isText(String ext) {
        switch (ext) {
            case "html":
            case "css":
            case "js":
            case "json":
            case "txt":
            case "svg":
                return true;
            default:
                return false;
        }
    }

    private static String mimeType(String ext) {
        switch (ext) {
            case "html": return "text/html";
            case "css": return "text/css";
            case "js": return "text/javascript";     // module scripts are refused under any other type
            case "json": return "application/json";
            case "png": return "image/png";
            case "svg": return "image/svg+xml";
            case "ogg": return "audio/ogg";
            case "woff2": return "font/woff2";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }
}
