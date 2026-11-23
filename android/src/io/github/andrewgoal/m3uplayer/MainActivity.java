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
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 海纳百川-播放器 Android TV 壳。
 *
 * 只做一件事：把网页播放器放进一个遥控器友好的 WebView 里。
 *   - 全屏、常亮、无标题栏
 *   - 允许无手势自动播放（电视上没法先点一下）
 *   - HTML5 视频全屏交给 WebChromeClient 渲染
 *   - 返回键先问网页（关控制条 / 退全屏），没人处理才退出应用
 *   - 遥控器播放/暂停/快进/上一台/下一台映射给网页
 *
 * 地址可用 adb 覆盖，方便本地调试：
 *   adb shell am start -n io.github.andrewgoal.m3uplayer/.MainActivity -e url http://192.168.1.2:8080/?tv=1
 */
public class MainActivity extends Activity {

    private static final String TAG = "M3UPlayerTV";
    private static final String DEFAULT_URL = "https://andrewgoal.github.io/m3u-player/?tv=1";

    private FrameLayout root;
    private WebView webView;
    private TextView errorView;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

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

        String url = DEFAULT_URL;
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
            public void onReceivedError(WebView wv, WebResourceRequest request, android.webkit.WebResourceError error) {
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

        return view;
    }

    private void goImmersive() {
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

    private void showError(String message) {
        errorView.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    private void retry() {
        errorView.setVisibility(View.GONE);
        if (webView != null) webView.reload();
    }

    /** 遥控器按键 → 网页。返回 true 表示应用自己吃掉了。 */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
                retry();
                return true;
            }
        }

        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return sendTvKey("play");
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return sendTvKey("pause");
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return sendTvKey("toggle");
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                return sendTvKey("next");
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                return sendTvKey("prev");
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return sendTvKey("ff");
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return sendTvKey("rew");
            default:
                break;
        }
        return super.onKeyDown(keyCode, event);
    }

    private boolean sendTvKey(String name) {
        if (webView == null) return false;
        webView.evaluateJavascript(
                "window.__tvKey ? window.__tvKey('" + name + "') : false", null);
        return true;
    }

    /** 返回键：先让网页关掉控制条 / 退全屏，网页不要了才退出。 */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__tvBack && window.__tvBack());}catch(e){return false;}})()",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(final String value) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (!"true".equals(value)) {
                                    MainActivity.super.onBackPressed();
                                }
                            }
                        });
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()", null);
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
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
