package io.github.andrewgoal.m3uplayer.simple;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.SurfaceView;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * 原生播放：SurfaceView + ExoPlayer（Media3）。
 *
 * 用 ExoPlayer 一个引擎覆盖所有源：
 *   - mp4 / ts 直连
 *   - m3u8：TS 分片、fMP4（#EXT-X-MAP）都支持
 * 全部走系统 MediaCodec 硬解，不碰 WebView 的合成管线。
 *
 * ExoPlayer 是单线程对象，所有调用都在主线程；解码/下载由它自己的线程做。
 */
final class NativePlayer {

    interface Listener {
        /** type: ready / playing / paused / ended / error / buffering；a: 时长(ms) 或 1/0 */
        void onState(String type, long a);

        /** 每 500ms 汇报一次进度，页面不用自己轮询。 */
        void onTick(long position, long duration, boolean playing);
    }

    private final Context context;
    private final SurfaceView surfaceView;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private long lastDuration = 0;
    private int liveRetries = 0;

    private final Player.Listener events = new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_BUFFERING) {
                emit("buffering", 1);
            } else if (state == Player.STATE_READY) {
                liveRetries = 0;
                lastDuration = normalizeDuration(player == null ? 0 : player.getDuration());
                emit("ready", lastDuration);
                emit("buffering", 0);
                if (player != null && player.isPlaying()) emit("playing", 0);
            } else if (state == Player.STATE_ENDED) {
                emit("ended", 0);
            }
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            if (isPlaying) emit("playing", 0);
            else emit("paused", 0);
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            // 直播起播慢于分片窗口（BEHIND_LIVE_WINDOW）时，重新 prepare 会回到直播边缘。
            // 只重试一次，别把真的播不了拖成死循环。
            if (player != null
                    && error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW
                    && liveRetries < 1) {
                liveRetries += 1;
                try {
                    player.prepare();
                    player.setPlayWhenReady(true);
                    return;
                } catch (Exception ignored) { }
            }
            emit("error", 0);
        }
    };

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            listener.onTick(player.getCurrentPosition(), lastDuration, player.isPlaying());
            main.postDelayed(this, 500);
        }
    };

    NativePlayer(Context context, SurfaceView surfaceView, Listener listener) {
        this.context = context;
        this.surfaceView = surfaceView;
        this.listener = listener;
    }

    private static long normalizeDuration(long duration) {
        return duration == C.TIME_UNSET || duration <= 0 ? 0 : duration;
    }

    void open(String url, boolean hls) {
        stop();
        try {
            MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
            if (hls) item.setMimeType(MimeTypes.APPLICATION_M3U8);

            ExoPlayer created = new ExoPlayer.Builder(context).build();
            created.setVideoSurfaceView(surfaceView);
            created.addListener(events);
            created.setMediaItem(item.build());
            created.setVolume(1f);
            created.prepare();
            created.setPlayWhenReady(true);
            player = created;
            lastDuration = 0;
            liveRetries = 0;
            main.removeCallbacks(ticker);
            main.post(ticker);
        } catch (Exception error) {
            emit("error", 0);
        }
    }

    void play() {
        if (player == null) return;
        try {
            player.setPlayWhenReady(true);
        } catch (Exception ignored) { }
    }

    void pause() {
        if (player == null) return;
        try {
            player.setPlayWhenReady(false);
        } catch (Exception ignored) { }
    }

    void seek(long ms) {
        if (player == null || ms < 0) return;
        try {
            long target = ms;
            if (lastDuration > 0) target = Math.min(target, lastDuration);
            player.seekTo(target);
        } catch (Exception ignored) { }
    }

    void stop() {
        main.removeCallbacks(ticker);
        if (player == null) return;
        try {
            player.setPlayWhenReady(false);
            player.stop();
            player.release();
        } catch (Exception ignored) { }
        player = null;
    }

    void destroy() {
        stop();
    }

    private void emit(String type, long value) {
        listener.onState(type, value);
    }
}
