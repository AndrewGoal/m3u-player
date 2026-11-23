package io.github.andrewgoal.m3uplayer.simple;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

import io.github.andrewgoal.m3uplayer.ShellActivity;

/**
 * 简洁版壳：网页负责菜单 / 进度条 / 按键，画面交给原生 MediaPlayer。
 *
 * 布局：SurfaceView（底层，硬解出画） + 透明 WebView（上层，只画界面）。
 *
 *   方向键 / OK 直接进网页处理
 *   菜单键 → 换源层
 *   返回键 → 先关面板；没面板时要连按两次才退出（防误触）
 *   媒体键 → 播放/暂停、上一台/下一台、快进/快退
 *
 * 网页通过 TVShell.* 控制播放；原生播放器通过 window.__nativeEvent / __nativeTick 回报状态。
 */
public class SimpleActivity extends ShellActivity {

    private static final String DEFAULT_URL = "https://andrewgoal.github.io/m3u-player/simple.html?tv=1";
    private static final long EXIT_WINDOW_MS = 1600;

    /** 原生播放失败时，网页可以退回 <video>；这里优先还是让系统播放器接手。 */
    private static final String[] PLAYER_PACKAGES = {
            "org.videolan.vlc",
            "com.fongmi.android.tv",
            "com.github.tvbox.osc",
            "com.github.tvbox.pro",
            "org.xbmc.kodi"
    };

    private SurfaceView surfaceView;
    private NativePlayer player;
    private long lastBackAt = 0;

    @Override
    protected String defaultUrl() {
        // 每次启动都带一个时间戳：GitHub Pages 给 HTML 也缓存 10 分钟，
        // 不加的话改完前端要等很久才生效。css/js 由页面自己的 ?v= 控制。
        return DEFAULT_URL + "&_=" + System.currentTimeMillis();
    }

    @Override
    protected void onRootCreated(FrameLayout container) {
        container.setBackgroundColor(Color.TRANSPARENT);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));

        surfaceView = new SurfaceView(this);
        surfaceView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        container.addView(surfaceView);

        player = new NativePlayer(this, surfaceView, new NativePlayer.Listener() {
            @Override
            public void onState(final String type, final long value) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        js("window.__nativeEvent && window.__nativeEvent('" + type + "'," + value + ")");
                    }
                });
            }

            @Override
            public void onTick(final long position, final long duration, final boolean playing,
                               final long bytesPerSecond) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        js("window.__nativeTick && window.__nativeTick(" + position + "," + duration + ","
                                + (playing ? "1" : "0") + "," + bytesPerSecond + ")");
                    }
                });
            }
        });
    }

    @Override
    protected void onWebViewCreated(WebView view) {
        view.setBackgroundColor(Color.TRANSPARENT);
        view.addJavascriptInterface(new Bridge(), "TVShell");
    }

    /** 网页调用的原生播放接口（JS 线程 → 主线程）。 */
    private class Bridge {
        @JavascriptInterface
        public void playerOpen(final String url, final boolean hls) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (player != null) player.open(url, hls);
                }
            });
        }

        @JavascriptInterface
        public void playerPlay() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (player != null) player.play();
                }
            });
        }

        @JavascriptInterface
        public void playerPause() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (player != null) player.pause();
                }
            });
        }

        @JavascriptInterface
        public void playerSeek(final long ms) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (player != null) player.seek(ms);
                }
            });
        }

        @JavascriptInterface
        public void playerStop() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (player != null) player.stop();
                }
            });
        }

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
    protected void onShellPause() {
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.destroy();
            player = null;
        }
        super.onDestroy();
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
