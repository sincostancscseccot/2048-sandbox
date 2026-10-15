package com.sandbox2048.app;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;
import android.view.MotionEvent;
import org.json.JSONArray;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real Android WebView + native file bridge smoke checks, without an external test framework. */
public final class SmokeTestRunner extends Instrumentation {
    private MainActivity activity;
    private WebView web;
    private final StringBuilder checks = new StringBuilder();
    private static final Uri DOCUMENT = Uri.parse("content://com.sandbox2048.app.test.fixtures/backup");
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle report = new Bundle();
        try {
            launch();
            waitFor("!!document.querySelector('.start-button')", "offline first launch");
            check("window.isSecureContext && !!window.indexedDB && !!crypto.randomUUID && !!window.AndroidFiles", "secure offline origin and native bridge");
            waitFor("document.body.textContent.includes('离线资源已内置')", "bundled offline resources");
            click("document.querySelector('.start-button')");
            waitFor("document.querySelector('[data-testid=save-status]')?.textContent === '已自动保存'", "new game auto-save");
            for (String label : new String[]{"向左移动", "向右移动", "向上移动", "向下移动"}) {
                click("document.querySelector('[aria-label=" + label + "]')");
                SystemClock.sleep(350);
                if ("true".equals(js("Number(document.querySelector('[data-testid=action-count]')?.textContent) > 0"))) break;
            }
            waitFor("Number(document.querySelector('[data-testid=action-count]')?.textContent) > 0 && document.querySelector('[data-testid=save-status]')?.textContent === '已自动保存'", "move and persist a node");
            Instrumentation.ActivityMonitor exportMonitor = picker(Intent.ACTION_CREATE_DOCUMENT, Activity.RESULT_OK);
            button("导出备份");
            waitFor("[...document.querySelectorAll('header button')].some(b => b.textContent === '导出备份' && !b.disabled)", "native document export completed");
            if (exportMonitor.getHits() != 1) throw new AssertionError("Export did not use the Android document picker");
            removeMonitor(exportMonitor);
            try (InputStream input = getContext().getContentResolver().openInputStream(DOCUMENT)) {
                if (input == null || input.read() != 'P' || input.read() != 'K') throw new AssertionError("Native backup is not a ZIP container");
            }
            checks.append("native backup bytes written through ContentResolver\n");
            Instrumentation.ActivityMonitor cancelMonitor = picker(Intent.ACTION_CREATE_DOCUMENT, Activity.RESULT_CANCELED);
            button("导出备份");
            waitFor("document.body.textContent.includes('已取消保存文件')", "native save cancellation reported");
            if (cancelMonitor.getHits() != 1) throw new AssertionError("Cancelled save incorrectly retried as a raw recovery export");
            removeMonitor(cancelMonitor);
            Instrumentation.ActivityMonitor importMonitor = picker(Intent.ACTION_OPEN_DOCUMENT, Activity.RESULT_OK);
            button("文件与恢复");
            waitFor("!!document.querySelector('input[type=file]')", "native import modal");
            tapFileInput();
            waitFor("document.body.textContent.includes('文件已验证')", "native chooser imported and validated the exported archive");
            if (importMonitor.getHits() != 1) throw new AssertionError("Import did not use the Android document picker");
            removeMonitor(importMonitor);
            button("导入副本");
            waitFor("document.body.textContent.includes('已完成导入')", "native restore creates an independent copy");
            button("开始查看");
            button("帮助");
            waitFor("!!document.querySelector('dialog[open]')", "help modal opened");
            runOnMainSync(() -> activity.onBackPressed());
            waitFor("!document.querySelector('dialog[open]') && !!document.querySelector('[data-testid=board]')", "Android back closes modal");
            runOnMainSync(() -> activity.onBackPressed());
            waitFor("!!document.querySelector('.resume-library') && !document.querySelector('[data-testid=board]')", "Android back returns home");
            runOnMainSync(() -> activity.finish());
            launch();
            waitFor("!!document.querySelector('[data-testid=board]')", "saved game survives Activity restart");
            check("Number(document.querySelector('[data-testid=action-count]')?.textContent) > 0", "saved move restored");
            click("[...document.querySelectorAll('header button')].find(b => b.textContent.startsWith('我的对局'))");
            waitFor("document.querySelectorAll('.library-record').length === 2", "original and imported games persist independently");
            check("performance.getEntriesByType('resource').every(e => e.name.startsWith('https://appassets.androidplatform.net/'))", "all loaded resources come from APK assets");
            report.putString("stream", "\nALL_NATIVE_SMOKE_CHECKS_PASSED\n" + checks);
            finish(Activity.RESULT_OK, report);
        } catch (Throwable failure) {
            StringWriter stack = new StringWriter(); failure.printStackTrace(new PrintWriter(stack));
            report.putString("stream", "\nNATIVE_SMOKE_FAILED\n" + checks + stack);
            finish(Activity.RESULT_CANCELED, report);
        }
    }
    private void launch() throws Exception {
        activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Field field = MainActivity.class.getDeclaredField("webView"); field.setAccessible(true); web = (WebView) field.get(activity);
    }
    private String js(String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        runOnMainSync(() -> web.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("WebView evaluation timed out");
        return result.get();
    }
    private void check(String expression, String label) throws Exception {
        if (!"true".equals(js(expression))) throw new AssertionError(label);
        checks.append(label).append('\n');
    }
    private void waitFor(String expression, String label) throws Exception {
        long until = SystemClock.elapsedRealtime() + 30000;
        do {
            if ("true".equals(js(expression))) { checks.append(label).append('\n'); return; }
            SystemClock.sleep(100);
        } while (SystemClock.elapsedRealtime() < until);
        throw new AssertionError(label + ": " + js("document.body?.innerText"));
    }
    private void click(String element) throws Exception { js("(" + element + ").click()"); }
    private void tapFileInput() throws Exception {
        js("document.querySelector('.dropzone').scrollIntoView({block:'center'})");
        JSONArray point = new JSONArray(js("(()=>{const r=document.querySelector('.dropzone').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"));
        int[] origin = new int[2]; AtomicReference<Float> scale = new AtomicReference<>();
        runOnMainSync(() -> { web.getLocationOnScreen(origin); scale.set(web.getScale()); });
        float x = origin[0] + (float) point.getDouble(0) * scale.get();
        float y = origin[1] + (float) point.getDouble(1) * scale.get();
        long now = SystemClock.uptimeMillis();
        sendPointerSync(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0));
        sendPointerSync(MotionEvent.obtain(now, now + 80, MotionEvent.ACTION_UP, x, y, 0));
    }
    private void button(String text) throws Exception {
        click("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '" + text + "')");
    }
    private Instrumentation.ActivityMonitor picker(String action, int result) throws IntentFilter.MalformedMimeTypeException {
        IntentFilter filter = new IntentFilter(action); filter.addCategory(Intent.CATEGORY_OPENABLE);
        filter.addDataType("*/*");
        Intent selected = new Intent().setData(DOCUMENT);
        return addMonitor(filter, new Instrumentation.ActivityResult(result, selected), true);
    }
}
