package io.github.andrewgoal.m3uplayer.simple;

import android.content.Context;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

/**
 * 原生播放：SurfaceView + MediaPlayer（系统硬解）。
 *
 * 只用 Android 自带的 MediaPlayer，不引入 AndroidX / ExoPlayer：
 *   - http(s) 的 mp4 直接播
 *   - m3u8（HLS）交给平台解析，TS 走硬解
 *
 * 所有 MediaPlayer 调用都跑在单独的线程上：这台盒子上 reset()/release()
 * 偶尔会卡几百毫秒，放主线程会直接 ANR。
 */
final class NativePlayer implements SurfaceHolder.Callback,
        MediaPlayer.OnPreparedListener,
        MediaPlayer.OnCompletionListener,
        MediaPlayer.OnErrorListener,
        MediaPlayer.OnInfoListener {

    interface Listener {
        /** type: ready / playing / paused / ended / error / buffering；a: 时长(ms) 或 1/0 */
        void onState(String type, long a);

        /** 播放线程每 500ms 汇报一次，页面不用跨线程调 MediaPlayer。 */
        void onTick(long position, long duration, boolean playing);
    }

    private final Context context;
    private final SurfaceView surfaceView;
    private final Listener listener;

    private final HandlerThread thread;
    private final Handler worker;

    private MediaPlayer player;
    private Surface surface;
    private String pendingUrl;
    private volatile boolean prepared;
    private volatile boolean released;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (released || player == null || !prepared) return;
            listener.onTick(positionInternal(), durationInternal(), isPlayingInternal());
            worker.postDelayed(this, 500);
        }
    };

    NativePlayer(Context context, SurfaceView surfaceView, Listener listener) {
        this.context = context;
        this.surfaceView = surfaceView;
        this.listener = listener;
        this.thread = new HandlerThread("native-player");
        this.thread.start();
        this.worker = new Handler(thread.getLooper());
        surfaceView.getHolder().addCallback(this);
    }

    private void post(Runnable task) {
        if (released) return;
        worker.post(task);
    }

    /* ---------- 表面（主线程回调 → 转给播放线程） ---------- */

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        final Surface created = holder.getSurface();
        post(new Runnable() {
            @Override
            public void run() {
                surface = created;
                if (pendingUrl != null && player == null) load(pendingUrl);
                else if (player != null) {
                    try { player.setSurface(surface); } catch (Exception ignored) { }
                }
            }
        });
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        final Surface changed = holder.getSurface();
        post(new Runnable() {
            @Override
            public void run() {
                surface = changed;
            }
        });
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        post(new Runnable() {
            @Override
            public void run() {
                surface = null;
                if (player != null) {
                    try { player.setSurface(null); } catch (Exception ignored) { }
                }
            }
        });
    }

    /* ---------- 播放（都走播放线程） ---------- */

    void open(final String url) {
        post(new Runnable() {
            @Override
            public void run() {
                pendingUrl = url;
                releasePlayer();
                load(url);
            }
        });
    }

    private void load(String url) {
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setAudioStreamType(AudioManager.STREAM_MUSIC);
            mp.setDataSource(context, Uri.parse(url));
            if (surface != null) mp.setSurface(surface);
            mp.setOnPreparedListener(this);
            mp.setOnCompletionListener(this);
            mp.setOnErrorListener(this);
            mp.setOnInfoListener(this);
            mp.setVolume(1f, 1f);
            prepared = false;
            player = mp;
            mp.prepareAsync();
        } catch (Exception error) {
            emit("error", 0);
        }
    }

    void play() {
        post(new Runnable() {
            @Override
            public void run() {
                if (player == null || !prepared) return;
                try {
                    player.start();
                    emit("playing", 0);
                } catch (Exception ignored) { }
            }
        });
    }

    void pause() {
        post(new Runnable() {
            @Override
            public void run() {
                if (player == null || !prepared) return;
                try {
                    if (player.isPlaying()) {
                        player.pause();
                        emit("paused", 0);
                    }
                } catch (Exception ignored) { }
            }
        });
    }

    private boolean isPlayingInternal() {
        try {
            return player != null && prepared && player.isPlaying();
        } catch (Exception ignored) {
            return false;
        }
    }

    private long positionInternal() {
        try {
            return player != null && prepared ? player.getCurrentPosition() : 0;
        } catch (Exception ignored) {
            return 0;
        }
    }

    /** 直播返回 0。 */
    private long durationInternal() {
        try {
            if (player == null || !prepared) return 0;
            long d = player.getDuration();
            return d > 0 ? d : 0;
        } catch (Exception ignored) {
            return 0;
        }
    }

    void seek(final long ms) {
        post(new Runnable() {
            @Override
            public void run() {
                if (player == null || !prepared || ms < 0) return;
                try {
                    long target = ms;
                    long total = durationInternal();
                    if (total > 0) target = Math.min(target, total);
                    player.seekTo((int) target);
                } catch (Exception ignored) { }
            }
        });
    }

    void stop() {
        post(new Runnable() {
            @Override
            public void run() {
                pendingUrl = null;
                releasePlayer();
            }
        });
    }

    private void releasePlayer() {
        worker.removeCallbacks(ticker);
        if (player == null) return;
        try { player.reset(); } catch (Exception ignored) { }
        try { player.release(); } catch (Exception ignored) { }
        player = null;
        prepared = false;
    }

    /* ---------- 回调（播放线程） ---------- */

    @Override
    public void onPrepared(MediaPlayer mp) {
        if (released || mp != player) return;
        prepared = true;
        emit("ready", durationInternal());
        try { mp.start(); } catch (Exception ignored) { }
        emit("playing", 0);
        worker.removeCallbacks(ticker);
        worker.post(ticker);
    }

    @Override
    public void onCompletion(MediaPlayer mp) {
        emit("ended", 0);
    }

    @Override
    public boolean onError(MediaPlayer mp, int what, int extra) {
        emit("error", what);
        releasePlayer();
        return true;
    }

    @Override
    public boolean onInfo(MediaPlayer mp, int what, int extra) {
        if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) emit("buffering", 1);
        else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) emit("buffering", 0);
        return false;
    }

    private void emit(String type, long value) {
        if (released) return;
        listener.onState(type, value);
    }

    void destroy() {
        released = true;
        surfaceView.getHolder().removeCallback(this);
        worker.post(new Runnable() {
            @Override
            public void run() {
                releasePlayer();
            }
        });
        worker.postDelayed(new Runnable() {
            @Override
            public void run() {
                thread.quitSafely();
            }
        }, 800);
    }
}
