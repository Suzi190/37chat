package com.yunyue.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 云曰 —— 极简 WebView 壳，只做四件事：
 *
 * 1. 全屏：隐藏系统栏，内容画进刘海/挖孔区，并把刘海高度以 --android-inset-top 传给页面；
 * 2. 返回键 / 系统返回手势交给页面（window.__appBack），页面回不去才退出 App；
 * 3. 让 &lt;input type="file"&gt;（导入备份、换头像…）能调起系统文件选择器；
 * 4. 让 blob: 导出（备份 JSON）能真正写到「下载/云曰/」里。
 *
 * 页面放在 assets/www，通过 https://localhost/ 这个假域名提供，
 * 这样 IndexedDB / localStorage / crypto / fetch 都是正常的“安全来源”，
 * 不会像 file:// 那样被各种限制（数据导入导出能正常工作也依赖这一点）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "YunYue";
    private static final String APP_HOST = "localhost";
    private static final String START_URL = "https://" + APP_HOST + "/index.html";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_WRITE_STORAGE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private int topInsetPx = 0;

    /** 正在写入的导出文件：JS 分片传过来，这里顺序写盘 */
    private final Map<String, SaveSession> sessions = new ConcurrentHashMap<>();

    private static final class SaveSession {
        OutputStream out;
        Uri uri;           // Android 10+ 的 MediaStore 条目
        String shownPath;  // 提示给用户看的路径
    }

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyFullscreen();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0E0C0A);

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        // decorView 就绪后再设一次，确保系统栏真的被隐藏（Android 11+ 更稳）
        applyFullscreen();

        // 需要连电脑调试网页时可以打开 chrome://inspect
        WebView.setWebContentsDebuggingEnabled(true);

        configureWebView();
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null || url.startsWith("blob:")) {
                // blob: 交给页面里的 JS 桥接处理（见 app/index.html 末尾的适配脚本）
                return;
            }
            openInBrowser(Uri.parse(url));
        });

        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top = topInsetOf(insets);
            if (top != topInsetPx) {
                topInsetPx = top;
                pushSafeAreaToPage();
            }
            return insets;
        });

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 用户可能把接口地址填成局域网 http://192.168.x.x，别拦
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " YunYueApp/" + versionName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }

    /** 真全屏：隐藏状态栏和导航栏，内容铺到刘海/挖孔区，边缘滑动可临时唤出系统栏 */
    @SuppressLint("ObsoleteSdkInt")
    private void applyFullscreen() {
        WindowManager.LayoutParams params = getWindow().getAttributes();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        getWindow().setAttributes(params);
        getWindow().setStatusBarColor(0x00000000);
        getWindow().setNavigationBarColor(0x00000000);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    private int topInsetOf(WindowInsets insets) {
        if (insets == null) {
            return 0;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Insets bars = insets.getInsets(
                    WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout());
            return bars.top;
        }
        return insets.getSystemWindowInsetTop();
    }

    /** 把刘海高度（dp）写进页面，页面用它给顶部模拟状态栏留白，内容就不会被挖孔挡住 */
    private void pushSafeAreaToPage() {
        if (webView == null) {
            return;
        }
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) {
            density = 1f;
        }
        String dp = String.format(Locale.US, "%.2f", topInsetPx / density);
        String js = "(function(){try{document.documentElement.style.setProperty('--android-inset-top','"
                + dp + "px');}catch(e){}})();";
        webView.evaluateJavascript(js, null);
    }

    /**
     * 返回键 / 系统返回手势：先问页面“能不能退一页”。
     * 页面回不去（已经在桌面）才真的退出 App。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__appBack && window.__appBack());}"
                        + "catch(e){return false;}})();",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyFullscreen();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                pendingFileCallback.onReceiveValue(result);
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Android 7~9 导出到公共「下载」目录需要写权限，10+ 走 MediaStore 不需要 */
    private void requestLegacyStoragePermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    REQ_WRITE_STORAGE);
        }
    }

    private void openInBrowser(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Log.w(TAG, "无法打开链接: " + uri, e);
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    /**
     * 把 https://localhost/xxx 的请求映射到 assets/www/xxx。
     * 用 https 是为了拿到“安全来源”，IndexedDB / crypto / fetch 才不受限制。
     */
    private WebResourceResponse assetResponse(String path) {
        String clean = (path == null || path.isEmpty() || "/".equals(path)) ? "/index.html" : path;
        clean = clean.replace("..", "");
        String assetPath = "www" + clean;
        try {
            InputStream in = getAssets().open(assetPath);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(guessMime(clean), "UTF-8", 200, "OK", headers, in);
        } catch (IOException missing) {
            try {
                // 单页应用：未知路径回落到 index.html
                InputStream in = getAssets().open("www/index.html");
                return new WebResourceResponse("text/html", "UTF-8",
                        200, "OK", new HashMap<>(), in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "UTF-8",
                        404, "Not Found", new HashMap<>(),
                        new ByteArrayInputStream("Not Found".getBytes()));
            }
        }
    }

    private String guessMime(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".css")) {
            return "text/css";
        }
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        if (lower.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".webp")) {
            return "image/webp";
        }
        if (lower.endsWith(".gif")) {
            return "image/gif";
        }
        if (lower.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (lower.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (lower.endsWith(".woff")) {
            return "font/woff";
        }
        if (lower.endsWith(".ttf")) {
            return "font/ttf";
        }
        if (lower.endsWith(".mp3")) {
            return "audio/mpeg";
        }
        if (lower.endsWith(".mp4")) {
            return "video/mp4";
        }
        if (lower.endsWith(".txt")) {
            return "text/plain";
        }
        String ext = MimeTypeMap.getFileExtensionFromUrl(lower);
        if (ext != null) {
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime != null) {
                return mime;
            }
        }
        return "application/octet-stream";
    }

    /** 页面里所有资产都从 assets 走；只有跳到外站才交给系统浏览器 */
    private final class AppWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri != null && APP_HOST.equals(uri.getHost())) {
                return assetResponse(uri.getPath());
            }
            return null;
        }

        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (APP_HOST.equals(uri.getHost())) {
                return assetResponse(uri.getPath());
            }
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        private boolean handleUrl(Uri uri) {
            if (uri == null) {
                return false;
            }
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
            if (APP_HOST.equals(uri.getHost())) {
                return false; // 应用内部路由，留在 WebView
            }
            if ("http".equals(scheme) || "https".equals(scheme)) {
                openInBrowser(uri); // 外链用系统浏览器打开
                return true;
            }
            if ("mailto".equals(scheme) || "tel".equals(scheme) || "sms".equals(scheme)) {
                openInBrowser(uri);
                return true;
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                Log.w(TAG, "页面加载失败: " + request.getUrl() + " → " + error.getDescription());
            }
        }
    }

    /** 让 <input type="file"> 能调起系统选择器（导入备份 / 选图片） */
    private final class AppChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view,
                                         ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams params) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = null;
            }
            pendingFileCallback = filePathCallback;

            Intent intent;
            try {
                intent = params.createIntent();
            } catch (Exception e) {
                Log.w(TAG, "createIntent 失败，退回通用选择器", e);
                intent = null;
            }
            if (intent == null) {
                intent = new Intent(Intent.ACTION_GET_CONTENT);
            }
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(
                        Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
            } catch (Exception e) {
                Log.e(TAG, "无法调起文件选择器", e);
                pendingFileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage msg) {
            // 打开 chrome://inspect 时能看到页面日志
            return super.onConsoleMessage(msg);
        }
    }

    /**
     * 给页面用的 JS 桥（window.AndroidBridge）。
     * 页面导出备份是 blob，WebView 不会真的下载，所以这里分片接过来自己写盘。
     */
    public final class Bridge {

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public void toast(String text) {
            if (text == null || text.isEmpty()) {
                return;
            }
            runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show());
        }

        @JavascriptInterface
        public boolean beginFile(String rawName, String mime) {
            if (rawName == null || rawName.trim().isEmpty()) {
                return false;
            }
            String name = sanitizeFileName(rawName);
            String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            try {
                SaveSession session = new SaveSession();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                            Environment.DIRECTORY_DOWNLOADS + "/云曰");
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) {
                        return false;
                    }
                    OutputStream out = getContentResolver().openOutputStream(uri, "w");
                    if (out == null) {
                        getContentResolver().delete(uri, null, null);
                        return false;
                    }
                    session.uri = uri;
                    session.out = out;
                    session.shownPath = "下载/云曰/" + name;
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    File target = new File(dir, name);
                    try {
                        if (!dir.exists()) {
                            //noinspection ResultOfMethodCallIgnored
                            dir.mkdirs();
                        }
                        session.out = new FileOutputStream(target);
                    } catch (IOException noPermission) {
                        // Android 7~9 还没授权：这次先落到 App 私有目录，并顺手申请一次权限
                        runOnUiThread(MainActivity.this::requestLegacyStoragePermissionIfNeeded);
                        File fallback = new File(
                                getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
                        session.out = new FileOutputStream(fallback);
                        target = fallback;
                    }
                    session.shownPath = target.getAbsolutePath();
                }
                sessions.put(name, session);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "beginFile 失败", e);
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendFileChunk(String name, String base64) {
            SaveSession session = sessions.get(name);
            if (session == null || session.out == null || base64 == null) {
                return false;
            }
            try {
                session.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "appendFileChunk 失败", e);
                return false;
            }
        }

        @JavascriptInterface
        public String endFile(String name) {
            SaveSession session = sessions.remove(name);
            if (session == null) {
                return "";
            }
            try {
                if (session.out != null) {
                    session.out.flush();
                    session.out.close();
                }
                if (session.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(session.uri, done, null, null);
                }
                return session.shownPath == null ? "" : session.shownPath;
            } catch (Exception e) {
                Log.e(TAG, "endFile 失败", e);
                return "";
            }
        }
    }

    private String sanitizeFileName(String raw) {
        String name = raw.replace('\\', '_').replace('/', '_').trim();
        name = name.replaceAll("[\\p{Cntrl}\":*?<>|]", "_");
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
            name = "云曰导出.txt";
        }
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }
}
