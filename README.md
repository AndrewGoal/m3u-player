# 通用 M3U / M3U8 网页播放器

一个零依赖、无广告、可嵌入的网页播放器：读 M3U/M3U8 文本，支持普通视频与 HLS 直播，支持静态文件、跨域 URL 和浏览器端 Provider 实时生成播放列表。

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

- [气象万千](https://andrewgoal.github.io/m3u-player/examples/weather.html)：Provider 在浏览器里实时抓取天气网/齐鲁网数据生成 M3U，失败回退静态文件。
- [IPTV 试播](https://andrewgoal.github.io/m3u-player/examples/iptv.html)：直接用 `?m3u=` 加载 `iptv.yang-1989.xyz/playlist.m3u`，来源：https://yang-1989.eu.org/

## 特性

- 解析 `#EXTINF`、`group-title`、`#EXTGRP`，按栏目筛选、搜索、自动连播
- hls.js + 原生 HLS 回退
- 自动升级 `http://` 播放地址到 `https://`
- 播放列表本地缓存，断网时可回退
- 定时检查更新，刷新列表不打断当前播放
- iframe 通信：`m3u-player:ready` / `change` / `playing` / `error`，以及 `refresh` / `play` 指令
- 配置化标题、时区、存储命名空间和数据源顺序

## 开发

```bash
npm test
```

静态文件由 GitHub Actions 部署到 GitHub Pages；播放器没有构建步骤。

## License

GPL-3.0
