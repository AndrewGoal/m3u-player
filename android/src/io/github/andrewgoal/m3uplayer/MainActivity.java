package io.github.andrewgoal.m3uplayer;

import android.view.KeyEvent;

/**
 * 完整版壳：加载带节目单/栏目/源面板的播放器页面。
 *
 *   返回键先交给网页（收控制条 → 退影院模式），网页不要了才退出应用
 *   遥控器播放/暂停/快进/上一台/下一台转发给 __tvKey
 */
public class MainActivity extends ShellActivity {

    private static final String DEFAULT_URL = "https://andrewgoal.github.io/m3u-player/?tv=1";

    @Override
    protected String defaultUrl() {
        return DEFAULT_URL;
    }

    @Override
    protected boolean handleShellKey(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                return sendKeyToPage("__tvKey", "play");
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                return sendKeyToPage("__tvKey", "pause");
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return sendKeyToPage("__tvKey", "toggle");
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                return sendKeyToPage("__tvKey", "next");
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                return sendKeyToPage("__tvKey", "prev");
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return sendKeyToPage("__tvKey", "ff");
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return sendKeyToPage("__tvKey", "rew");
            default:
                return false;
        }
    }

    @Override
    protected boolean handleShellBack() {
        askPageThenFinish("__tvBack");
        return true;
    }
}
