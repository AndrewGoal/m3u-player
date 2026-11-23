package io.github.andrewgoal.m3uplayer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 两个壳（完整版 / 简洁版）共用的 WebView 外壳。
 *
 * 只做播放之外的事情：全屏常亮、允许无手势自动播放、视频全屏渲染、加载失败重试。
 * 按键语义交给子类：完整版是焦点导航，简洁版是直给。
 *
 * 地址可用 adb 覆盖：
 *   adb shell am start -n <包名>/.<Activity> -e url http://192.168.1.2:8080/?tv=1
 */
public abstract class ShellActivity extends Activity {

    protected static final String TAG = "M3UPlayerTV";

    private FrameLayout root;
    protected WebView webView;
    private TextView errorView;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    /** 没有 intent extra 时加载的页面。 */
    protected abstract String defaultUrl();

    /** 子类自己的按键映射。返回 true 表示吃掉这次按键。 */
    protected boolean handleShellKey(int keyCode, KeyEvent event) {
        return false;
    }

    /** 返回键。返回 true 表示自己处理（例如关掉面板），false 交给系统退出。 */
    protected boolean handleShellBack() {
        return false;
    }

    /** WebView 建好后调用，子类可以挂 JavascriptInterface。 */
    protected void onWebViewCreated(WebView view) {
    }

    /** 根布局刚建好、WebView 还没加进去：子类可以在这里垫一层 SurfaceView。 */
    protected void onRootCreated(FrameLayout container) {
    }

    /** Activity 前后台切换，子类用来暂停原生播放器。 */
    protected void onShellPause() {
    }

    protected void onShellResume() {
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        onRootCreated(root);

        errorView = new TextView(this);
        errorView.setTextColor(Color.WHITE);
        errorView.setTextSize(22f);
        errorView.setGravity(android.view.Gravity.CENTER);
        errorView.setPadding(48, 48, 48, 48);
        errorView.setBackgroundColor(Color.BLACK);
        errorView.setVisibility(View.GONE);

        webView = createWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        goImmersive();

        String url = defaultUrl();
        Intent intent = getIntent();
        if (intent != null && intent.getStringExtra("url") != null) {
            url = intent.getStringExtra("url");
        }
        webView.loadUrl(url);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(Color.BLACK);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // 电视上没有“点一下”的机会，必须允许直接出声播放
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 播放列表里可能有 http 老源，页面是 https 时会按混合内容处理
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setUseWideViewPort(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUserAgentString(settings.getUserAgentString() + " M3UPlayerTV/1.0");
        // 调试用：电脑上 chrome://inspect 可以看页面和控制台
        WebView.setWebContentsDebuggingEnabled(true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView wv, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedError(WebView wv, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError("页面打不开\n\n" + error.getDescription() + "\n\n按 OK 重试，或检查网络。");
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                goImmersive();
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                webView.setVisibility(View.VISIBLE);
                if (fullscreenCallback != null) {
                    fullscreenCallback.onCustomViewHidden();
                    fullscreenCallback = null;
                }
                goImmersive();
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });

        onWebViewCreated(view);
        return view;
    }

    protected void goImmersive() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }

    protected void showError(String message) {
        errorView.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    protected void hideError() {
        errorView.setVisibility(View.GONE);
    }

    protected boolean errorShowing() {
        return errorView != null && errorView.getVisibility() == View.VISIBLE;
    }

    protected void retry() {
        hideError();
        if (webView != null) webView.reload();
    }

    /** 往页面里跑一段 JS（不关心返回值）。 */
    protected void js(String script) {
        if (webView == null) return;
        webView.evaluateJavascript(script, null);
    }

    /** 把遥控器按键转给页面里的 __tvKey / __simpleKey。 */
    protected boolean sendKeyToPage(String functionName, String keyName) {
        if (webView == null) return false;
        webView.evaluateJavascript(
                "window." + functionName + " ? window." + functionName + "('" + keyName + "') : false", null);
        return true;
    }

    /** 返回键先问页面，页面说不要了才真的退出。 */
    protected void askPageThenFinish(String functionName) {
        if (webView == null) {
            finish();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(" + functionName + " && window." + functionName +
                        "());}catch(e){return false;}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(final String value) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (!"true".equals(value)) finish();
                            }
                        });
                    }
                });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (errorShowing() && (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_DPAD_CENTER)) {
            retry();
            return true;
        }
        if (handleShellKey(keyCode, event)) return true;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (handleShellBack()) return;
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        onShellPause();
        if (webView != null) {
            js("(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()");
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        onShellResume();
        goImmersive();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
