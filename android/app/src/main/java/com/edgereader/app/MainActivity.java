package com.edgereader.app;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean backCallbackPending;
    private boolean destroyed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeTTS.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (backCallbackPending || destroyed) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // 向 WebView 注入 JS 調用，讓前端處理返回邏輯
            // 如果前端返回 false 表示已在書庫頁面，允許退出 app
            backCallbackPending = true;
            webView.evaluateJavascript(
                "(function() { " +
                "  if (typeof window.__handleAndroidBack === 'function') { " +
                "    return window.__handleAndroidBack(); " +
                "  } " +
                "  return false; " +
                "})()",
                result -> {
                    backCallbackPending = false;
                    if (destroyed) return;
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

    @Override
    public void onDestroy() {
        destroyed = true;
        backCallbackPending = false;
        super.onDestroy();
    }
}
