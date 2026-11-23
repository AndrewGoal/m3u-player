package io.github.andrewgoal.m3uplayer.simple;

import android.view.KeyEvent;

import io.github.andrewgoal.m3uplayer.ShellActivity;

/**
 * 简洁版壳：加载一个只有进度条的页面。
 *
 *   方向键 / OK 直接进网页处理
 *   菜单键 → 换源层
 *   返回键 → 先关面板，没面板时退出应用
 *   媒体键 → 播放/暂停、上一台/下一台、快进/快退
 */
public class SimpleActivity extends ShellActivity {

    private static final String DEFAULT_URL = "https://andrewgoal.github.io/m3u-player/simple.html?tv=1";

    @Override
    protected String defaultUrl() {
        return DEFAULT_URL;
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

    @Override
    protected boolean handleShellBack() {
        askPageThenFinish("__simpleBack");
        return true;
    }
}
