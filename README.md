# 海纳百川-播放器

海纳百川-播放器 是一个零依赖、无广告、可嵌入的网页播放器：读 M3U/M3U8 文本，支持普通视频与 HLS 直播，支持静态文件、跨域 URL 和浏览器端 Provider 实时生成播放列表。

在线地址：<https://andrewgoal.github.io/m3u-player/>

## 调用方式

最简单：

```html
<iframe
  src="https://andrewgoal.github.io/m3u-player/?embed=1&m3u=https%3A%2F%2Fexample.com%2Flist.m3u"
  title="播放列表"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen></iframe>
```

进阶方式（Provider + 静态兜底）见 [`docs/API.md`](docs/API.md)。

## 两个示例

- [气象万千](https://andrewgoal.github.io/m3u-player/examples/weather.html)：Provider 在浏览器里实时抓取天气网/齐鲁网数据生成 M3U，失败回退到[静态M3U文件（由气象万千项目每半小时生成一次）](https://andrewgoal.github.io/cctv_weather_forecasting_m3u/cctv_weather_forecasting.m3u)。
- [气象万千-直接加载以上M3U文件](https://andrewgoal.github.io/m3u-player/?m3u=https://andrewgoal.github.io/cctv_weather_forecasting_m3u/cctv_weather_forecasting.m3u)：https://andrewgoal.github.io/m3u-player/?m3u=https://andrewgoal.github.io/cctv_weather_forecasting_m3u/cctv_weather_forecasting.m3u
- [IPTV 试播](https://andrewgoal.github.io/m3u-player/examples/iptv.html)：直接用 `?m3u=` 加载 `iptv.yang-1989.xyz/playlist.m3u`，来源：https://yang-1989.eu.org/

## 特性

- 节目源区域：内置气象万千（现取）/ 气象万千（滞后 m3u 文件）/ IPTV M3U 三个不可删除的源，支持添加、删除、点击切换；`?sources=0` 可隐藏
- 解析 `#EXTINF`、`group-title`、`#EXTGRP`，按栏目筛选、搜索、自动连播
- hls.js + 原生 HLS 回退
- 自动升级 `http://` 播放地址到 `https://`
- 播放列表本地缓存，断网时可回退
- 可安装的 PWA：离线打开应用外壳、桌面图标、独立窗口，新版本就绪时提示刷新
- 定时检查更新，刷新列表不打断当前播放
- iframe 通信：`m3u-player:ready` / `change` / `playing` / `error`，以及 `refresh` / `play` 指令
- 配置化标题、时区、存储命名空间和数据源顺序

## 电视 / 遥控器

网页本身会识别 Android TV 之类的电视浏览器（也可以手动加 `?tv=1`），切换成 10 英尺界面：字号放大、列表在右、焦点框加粗，并接管遥控器按键。

| 按键 | 作用 |
| --- | --- |
| 方向键 | 在按钮 / 栏目 / 节目之间移动（几何空间导航，节目单里按左键回播放器） |
| OK / 确认 | 播放选中的节目、按下当前焦点按钮 |
| 播放 / 暂停 | 播放或暂停 |
| 上一台 / 下一台 | 切换节目（等价于媒体键上一曲 / 下一曲） |
| 快进 / 快退 | 点播快进 30 秒、快退 10 秒；直播则切台 |
| 返回 | 收起控制条 → 退出影院模式 → 退出应用 |

视频区自绘了控制条（上一台 / 播放暂停 / 下一台 / 进度 / 音量 / 影院模式），因为原生 `<video controls>` 不认遥控器。

### 简洁版（给老人用的大字版）

[`simple.html`](simple.html) 是另一个入口：打开就是全屏视频，界面上只有一条会自己消失的进度条，其余全交给遥控器。

| 按键 | 作用 |
| --- | --- |
| OK / 确认 | 播放 / 暂停 |
| 左右键 | 快退 / 快进 10 秒（进度条短暂出现） |
| 上下键 | 在**当前分类**里循环换台（换台时顶部短暂显示节目名） |
| 菜单键 | 换源层：居中半透明，上下选源，OK 拉取该源并打开换台层（同一个源不会重复拉取） |
| 换台层 | 靠左的两级联动列表：左右切分类 / 频道两栏，上下循环选择，OK 换台并关闭 |
| 返回键 | 先关面板；没有面板时**连按两次**退出（第一次提示「再按一次返回键退出」） |

字号按"坐在沙发上看得清"调的：节目名 27px、分类 24px、标题 30px，焦点框加粗到 2px。

换台时铺一层黑底转圈 + 台名，盖掉 WebView 自带的灰色播放占位图。

WebView 的视频合成管线在 RK3528 这类盒子上会掉帧（硬解是好的，瓶颈在 Chromium 合成），1080p 的 IPTV 直播尤其明显。换源层最后一行留了「用系统播放器打开」：选中后把当前频道交给机上的 VLC 等播放器，能明显顺一截；没装的话会退回系统选择框。

想让播放器出现在电视的桌面图标里，用同仓库里的极薄 WebView 壳：[`android/`](android/README.md)。壳只负责全屏、常亮、无手势自动播放、返回键和媒体键转发，页面仍然来自 GitHub Pages，改前端不用重装 APK。

```bash
cd android
./build.sh --launch             # 完整版：构建 + 安装 + 启动（需要 Android SDK 34 与 JDK 17）
./build.sh --simple --launch    # 简洁版：另一个 APK，可以和完整版同时装
```

## 开发

```bash
npm test
```

静态文件由 GitHub Actions 部署到 GitHub Pages；播放器没有构建步骤。

## License

GPL-3.0
