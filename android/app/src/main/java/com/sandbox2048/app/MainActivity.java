package com.sandbox2048.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Only bundled, trusted content is ever loaded into the bridge-enabled WebView. */
public final class MainActivity extends Activity {
    static final int IMPORT_FILE = 2048, EXPORT_FILE = 2049;
    static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private WebView webView;
    private ValueCallback<Uri[]> importCallback;
    private final FileBridge files = new FileBridge();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean destroyed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(245, 245, 239));
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        root.requestApplyInsets();
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Only URIs selected through the system file picker.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!trusted(url) || !"GET".equals(request.getMethod())) return missing();
                WebResourceResponse response = assets.shouldInterceptRequest(url);
                if (response == null) return missing();
                Map<String, String> headers = new HashMap<>();
                if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
                headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
                response.setResponseHeaders(headers);
                return response;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (trusted(request.getUrl())) return false;
                if (request.isForMainFrame() && "https".equals(request.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                    catch (ActivityNotFoundException ignored) { toast("没有可用的浏览器。"); }
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (importCallback != null) importCallback.onReceiveValue(null);
                importCallback = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(picker, IMPORT_FILE); }
                catch (ActivityNotFoundException ignored) { importCallback.onReceiveValue(null); importCallback = null; toast("没有可用的文件选择器。"); }
                return true;
            }
        });
        webView.addJavascriptInterface(files, "AndroidFiles");
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    private static boolean trusted(Uri url) {
        return "https".equals(url.getScheme()) && "appassets.androidplatform.net".equals(url.getHost())
            && (url.getPort() == -1 || url.getPort() == 443);
    }
    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private void toast(String message) { runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show()); }
    private void handleBack() {
        webView.evaluateJavascript("window.dispatchEvent(new Event('sandbox-native-back', {cancelable:true}))", result -> {
            if ("true".equals(result)) finish();
        });
    }
    @Override public void onBackPressed() { handleBack(); }
    @Override protected void onPause() { webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); webView.onResume(); }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == IMPORT_FILE && importCallback != null) {
            importCallback.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
            importCallback = null;
        } else if (request == EXPORT_FILE) {
            if (result == RESULT_OK && data != null && data.getData() != null) files.save(data.getData());
            else files.cancel();
        }
    }
    @Override protected void onDestroy() {
        destroyed = true;
        if (importCallback != null) importCallback.onReceiveValue(null);
        files.cancel();
        io.shutdownNow();
        webView.removeJavascriptInterface("AndroidFiles");
        webView.destroy();
        super.onDestroy();
    }

    private void complete(String id, String status, String message) {
        try {
            JSONObject detail = new JSONObject().put("id", id).put("status", status).put("message", message);
            String script = "window.dispatchEvent(new CustomEvent('sandbox-native-download',{detail:" + detail + "}))";
            runOnUiThread(() -> { if (!destroyed) webView.evaluateJavascript(script, null); });
        } catch (org.json.JSONException ignored) { toast("文件保存状态无法更新。"); }
    }

    private static final class ExportSession {
        final String id, filename, mime;
        final long expected;
        final File file;
        final FileOutputStream output;
        long written;
        boolean ready, saving;
        ExportSession(String id, String filename, String mime, long size, File directory) throws IOException {
            this.id = id; this.filename = filename; this.mime = mime; this.expected = size;
            file = File.createTempFile("sandbox-export-", ".tmp", directory);
            output = new FileOutputStream(file);
        }
        void discard() { try { output.close(); } catch (IOException ignored) {} file.delete(); }
    }

    public final class FileBridge {
        private ExportSession current;
        @JavascriptInterface public synchronized boolean begin(String id, String filename, String mime, long size) {
            if (destroyed || current != null || size < 0 || size > 64L * 1024 * 1024
                || id == null || !id.matches("[a-fA-F0-9-]{36}")
                || filename == null || !filename.matches("[a-zA-Z0-9._-]{1,180}")
                || !(filename.endsWith(".json") || filename.endsWith(".2048backup") || filename.endsWith(".2048lab") || filename.endsWith(".2048state"))
                || !("application/json".equals(mime) || "application/zip".equals(mime))) return false;
            try { current = new ExportSession(id, filename, mime, size, getCacheDir()); return true; }
            catch (IOException ignored) { return false; }
        }
        @JavascriptInterface public synchronized boolean append(String id, String encoded) {
            if (current == null || !current.id.equals(id) || current.ready || encoded == null || encoded.length() > 45000) return false;
            try {
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (current.written + bytes.length > current.expected) return false;
                current.output.write(bytes); current.written += bytes.length; return true;
            } catch (IOException | IllegalArgumentException ignored) { return false; }
        }
        @JavascriptInterface public synchronized boolean finish(String id) {
            if (current == null || !current.id.equals(id) || current.ready || current.written != current.expected) return false;
            try { current.output.close(); current.ready = true; }
            catch (IOException ignored) { return false; }
            ExportSession session = current;
            runOnUiThread(() -> {
                if (destroyed) return;
                Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(session.mime).putExtra(Intent.EXTRA_TITLE, session.filename);
                try { startActivityForResult(picker, EXPORT_FILE); }
                catch (ActivityNotFoundException ignored) { cancel(); toast("没有可用的文件保存窗口。"); }
            });
            return true;
        }
        @JavascriptInterface public synchronized void abort(String id) {
            if (current != null && current.id.equals(id) && !current.saving) { current.discard(); current = null; }
        }
        synchronized void cancel() {
            if (current == null || current.saving) return;
            String id = current.id; current.discard(); current = null;
            complete(id, "cancelled", "已取消保存文件。");
        }
        synchronized void save(Uri uri) {
            if (current == null || !current.ready || current.saving) return;
            ExportSession session = current; session.saving = true;
            io.execute(() -> {
                String status = "saved", message = "文件已保存。";
                try (FileInputStream input = new FileInputStream(session.file); OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException("No destination");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    output.flush();
                } catch (IOException | SecurityException ignored) { status = "failed"; message = "文件保存失败，请选择其他位置并重试。"; }
                synchronized (FileBridge.this) { session.discard(); if (current == session) current = null; }
                complete(session.id, status, message);
            });
        }
    }
}
