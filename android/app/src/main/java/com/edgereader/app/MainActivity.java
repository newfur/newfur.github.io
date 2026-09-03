package com.edgereader.app;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeTTS.class);
        super.onCreate(savedInstanceState);

        if (android.os.Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // 向 WebView 注入 JS 調用，讓前端處理返回邏輯
            // 如果前端返回 false 表示已在書庫頁面，允許退出 app
            webView.evaluateJavascript(
                "(function() { " +
                "  if (typeof window.__handleAndroidBack === 'function') { " +
                "    return window.__handleAndroidBack(); " +
                "  } " +
                "  return false; " +
                "})()",
                result -> {
                    // result 是 JS 返回值的字串形式："true" 或 "false"
                    if (!"true".equals(result)) {
                        // 前端未處理（已在書庫），允許退出
                        runOnUiThread(() -> {
                            MainActivity.super.onBackPressed();
                        });
                    }
                }
            );
        } else {
            super.onBackPressed();
        }
    }
}
