package io.github.andrewgoal.m3uplayer.simple;

import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.Toast;

import io.github.andrewgoal.m3uplayer.ShellActivity;

/**
 * 简洁版壳：加载一个只有进度条的页面。
 *
 *   方向键 / OK 直接进网页处理
 *   菜单键 → 换源层
 *   返回键 → 先关面板；没面板时要连按两次才退出（防误触）
 *   媒体键 → 播放/暂停、上一台/下一台、快进/快退
 *
 * 另外给页面一个 TVShell.openNative(url)：WebView 画面卡住时，
 * 可以把当前频道交给系统里的播放器（VLC 等）用硬解播放。
 */
public class SimpleActivity extends ShellActivity {

    private static final String DEFAULT_URL = "https://andrewgoal.github.io/m3u-player/simple.html?tv=1";
    private static final long EXIT_WINDOW_MS = 1600;

    /** 优先用装好的本机播放器，避免弹出选择框（遥控器选起来太费劲）。 */
    private static final String[] PLAYER_PACKAGES = {
            "org.videolan.vlc",
            "com.fongmi.android.tv",
            "com.github.tvbox.osc",
            "com.github.tvbox.pro",
            "org.xbmc.kodi"
    };

    private long lastBackAt = 0;

    @Override
    protected String defaultUrl() {
        return DEFAULT_URL;
    }

    @Override
    protected void onWebViewCreated(WebView view) {
        view.addJavascriptInterface(new NativeBridge(), "TVShell");
    }

    private class NativeBridge {
        @JavascriptInterface
        public void openNative(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    launchExternal(url);
                }
            });
        }
    }

    private void launchExternal(String url) {
        String type = url != null && url.contains(".m3u8") ? "application/x-mpegURL" : "video/*";
        Intent base = new Intent(Intent.ACTION_VIEW);
        base.setDataAndType(Uri.parse(url), type);
        base.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        for (String pkg : PLAYER_PACKAGES) {
            Intent intent = new Intent(base);
            intent.setPackage(pkg);
            if (getPackageManager().resolveActivity(intent, 0) != null) {
                try {
                    startActivity(intent);
                    return;
                } catch (Exception ignored) {
                    // 换下一个
                }
            }
        }

        try {
            startActivity(base);
        } catch (Exception error) {
            Toast.makeText(this, "没有可用的系统播放器", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected boolean handleShellKey(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_SETTINGS:
                return sendKeyToPage("__simpleKey", "menu");
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return sendKeyToPage("__simpleKey", "play");
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return sendKeyToPage("__simpleKey", "pause");
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return sendKeyToPage("__simpleKey", "toggle");
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                return sendKeyToPage("__simpleKey", "next");
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                return sendKeyToPage("__simpleKey", "prev");
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return sendKeyToPage("__simpleKey", "ff");
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return sendKeyToPage("__simpleKey", "rew");
            default:
                return false;
        }
    }

    /** 返回键：页面先关面板；页面没事干时连按两次才退出。 */
    @Override
    protected boolean handleShellBack() {
        if (webView == null) {
            finish();
            return true;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__simpleBack && window.__simpleBack());}catch(e){return false;}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(final String value) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if ("true".equals(value)) {
                                    // 关掉了一个面板，不算退出动作
                                    lastBackAt = 0;
                                    return;
                                }
                                long now = SystemClock.elapsedRealtime();
                                if (lastBackAt != 0 && now - lastBackAt <= EXIT_WINDOW_MS) {
                                    finish();
                                    return;
                                }
                                lastBackAt = now;
                                Toast.makeText(SimpleActivity.this,
                                        "再按一次返回键退出", Toast.LENGTH_SHORT).show();
                            }
                        });
                    }
                });
        return true;
    }
}
