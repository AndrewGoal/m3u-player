package io.github.andrewgoal.m3uplayer.tv;

import io.github.andrewgoal.m3uplayer.simple.SimpleActivity;

/**
 * 「看电视」入口：和简洁版同一个播放器，只是每次启动都直接进最后一个节目源
 * （电视节目 · 国内外电视台）。
 *
 * 之所以单独打包，是因为这台盒子的桌面（com.hisight.mslauncher）对每个包只显示
 * 一个图标，同一个 APK 里放两个 LAUNCHER 只会顶掉原来那个。
 */
public class TvActivity extends SimpleActivity {

    @Override
    protected String defaultUrl() {
        return super.defaultUrl() + "&src=last";
    }
}
