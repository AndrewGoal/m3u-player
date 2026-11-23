# Android TV 壳

两个变体，各是一个 Activity 的 WebView 壳，把网页播放器放进电视的桌面里，可以同时安装：

| 变体 | 包名 | 页面 | APK |
| --- | --- | --- | --- |
| 完整版 | `io.github.andrewgoal.m3uplayer` | `/?tv=1` | `m3u-player-tv.apk` |
| 简洁版 | `io.github.andrewgoal.m3uplayer.simple` | `/simple.html?tv=1` | `m3u-player-tv-simple.apk` |

两个都只做播放之外的事情（全屏、常亮、自动播放、按键转发），共用 `ShellActivity`；按键语义在 `MainActivity` / `simple/src/.../SimpleActivity.java` 里各写各的。它不做播放：

- 页面来自 `https://andrewgoal.github.io/m3u-player/?tv=1`，改前端不用重装 APK
- 全屏、常亮、无标题栏，遥控器返回键先交给网页（收控制条 / 退影院模式），网页不要了才退出
- 允许无手势自动播放（电视上没法先点一下）
- 遥控器播放/暂停/快进/上一台/下一台转发给网页
- HTML5 视频全屏交给 `WebChromeClient` 渲染

## 依赖

- JDK 17（build-tools 34 的 d8 在 JDK 21+ 会崩，脚本会自动切到 17）
- Android SDK：`build-tools;34.0.0` + `platforms;android-34`

```bash
sdkmanager "build-tools;34.0.0" "platforms;android-34"
```

## 构建 / 安装

```bash
./build.sh                       # 完整版：android/m3u-player-tv.apk
./build.sh --simple              # 简洁版：android/m3u-player-tv-simple.apk
./build.sh --install             # 构建并 adb install -r
./build.sh --simple --launch     # 构建、安装、启动简洁版
SERIAL=192.168.1.10:5555 ./build.sh --launch   # 指定设备
```

没有 Gradle：`aapt2` 编译资源 → `javac` 编译 → `d8` 转 dex → `zipalign` → `apksigner`。全流程几秒钟，只依赖 SDK 自带的工具。

首次构建会在 `~/.config/m3u-player-tv/tv.jks` 生成签名密钥（密码 `m3u-player-tv`）。想用自己的密钥：

```bash
KEYSTORE=/path/to/my.jks STOREPASS=xxxx ./build.sh
```

## 换地址

默认地址写在 `MainActivity.DEFAULT_URL`，也可以在运行时用 intent extra 覆盖（调试本地页面很方便）：

```bash
adb shell am start -n io.github.andrewgoal.m3uplayer/.MainActivity \
  -e url "http://192.168.1.2:8080/?tv=1"

adb shell am start -n io.github.andrewgoal.m3uplayer.simple/.SimpleActivity \
  -e url "http://192.168.1.2:8080/simple.html"
```

`--launch` 时也可以用环境变量临时指定（不改 APK 里的默认值）：

```bash
TV_URL="http://192.168.1.2:8080/?tv=1" ./build.sh --launch
```

要改 APK 的默认地址，编辑 `MainActivity.DEFAULT_URL` 后重新构建。

## 调试

壳打开了 WebView 调试（`setWebContentsDebuggingEnabled(true)`），电脑上：

```bash
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof io.github.andrewgoal.m3uplayer)
# Chrome 打开 chrome://inspect
```

页面里的 `console.log` 也会进 logcat：

```bash
adb logcat | grep M3UPlayerTV
```

## 说明

- 包里没有打包网页资源，断网时靠页面自己的 Service Worker 缓存兜底；要完全离线可以把 `../index.html`、`../player`、`../icons` 复制进 `assets/` 并改成 `file:///android_asset/index.html`，但那样每次改前端都要重装。
- `usesCleartextTraffic="true"`：部分老 IPTV 源还是 `http://`。
- 签名密钥不进仓库。换机器构建时把 `tv.jks` 一起带过去，否则只能卸载重装。
