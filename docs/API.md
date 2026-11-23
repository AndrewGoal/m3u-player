# 海纳百川-播放器接入说明

## 1. 最简单：URL 参数

默认页面：`https://andrewgoal.github.io/m3u-player/`

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `m3u=<地址>` | 自定义播放列表地址，需允许跨域 | `?m3u=https%3A%2F%2Fexample.com%2Flist.m3u` |
| `embed=1` | 隐藏页头页脚，适合 iframe | `?embed=1` |
| `title=<文本>` | 覆盖页面标题和品牌名 | `?title=IPTV` |
| `group=<栏目>` | 默认打开指定栏目 | `?group=新闻` |
| `play=<播放地址>` | 默认选中指定节目 | `?play=https%3A%2F%2F...%2Fa.mp4` |
| `autoplay=0` | 关闭打开时的自动播放 | `?autoplay=0` |
| `autoplay=muted` | 静音自动播放 | `?autoplay=muted` |
| `refresh=<分钟>` | 自动检查更新间隔，默认 30 | `?refresh=60` |
| `sources=0` | 隐藏节目源区域（深度定制场景） | `?sources=0` |
| `showSources=0` | 同上，语义更明确 | `?showSources=0` |

`?m3u=` 优先级最高：只要提供它，就会把它作为当前选中的临时节目源，其余内置源仍可用于切换。

播放器内置三个不可删除的节目源，默认依次为「气象万千 · 浏览器生成」「气象万千 · M3U 文件」「IPTV · M3U 文件」。选中的源失败时会依次尝试后面的源；用户自己添加的源可以删除，名称留空时随机取一个四字成语。

## 2. 配置对象

在加载播放器脚本之前声明：

```html
<script>
window.M3U_PLAYER_CONFIG = {
  id: 'my-player',                  // localStorage 与消息命名空间
  title: '我的播放列表',
  subtitle: '一句话说明',
  description: '页面描述',
  repo: 'https://github.com/you/repo', // 可选，页头/页脚链接
  parentOrigin: 'https://example.com', // 可选，限制 iframe 通信来源
  refreshMinutes: 30,
  timeZone: 'Asia/Shanghai',
  timezoneOffsetMinutes: 480,
  autoplay: 'muted',
  showSources: true,                // false 可隐藏节目源区域
  sources: [
    { label: '实时生成', provider: 'myProvider' },
    { label: '静态兜底', url: 'https://example.com/playlist.m3u' }
  ]
};
</script>
```

`timezoneOffsetMinutes` 用于从标题里的 `25日08:42` 这类文本推断发布时间；默认 `480`（北京时间）。不解析标题日期的普通 IPTV 列表可以忽略。

## 3. Provider：浏览器端实时生成

有些播放列表不适合提前生成成静态文件，比如带签名过期时间的视频地址，或者想省掉服务端定时任务。这时可以注册 Provider。

先加载 SDK，再加载 Provider 脚本，最后加载播放器：

```html
<script src="https://cdn.jsdelivr.net/gh/AndrewGoal/m3u-player@v1.5/player/sdk.js"></script>
<script src="./my-provider.js"></script>
<script src="https://cdn.jsdelivr.net/gh/AndrewGoal/m3u-player@v1.5/player/playlist.js"></script>
<script src="https://cdn.jsdelivr.net/gh/AndrewGoal/m3u-player@v1.5/player/vendor/hls.light.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/AndrewGoal/m3u-player@v1.5/player/app.js"></script>
```

Provider 脚本：

```js
M3UPlayer.registerProvider('myProvider', async function () {
  const text = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="直播",示例频道',
    'https://example.com/live.m3u8'
  ].join('\n');

  return {
    text: text,                 // 必填，完整 m3u 文本
    baseUrl: location.href,     // 可选，解析相对地址用
    url: '',                    // 可选，有稳定 URL 时填，用于「原始地址」和下载
    lastModified: new Date().toUTCString()
  };
});
```

`resolveSource()` 会按顺序尝试 `sources`；某个 Provider 抛错、返回空文本或解析不到节目时，自动尝试下一个源，最后才读本地缓存。

Provider 就是普通 JavaScript，**只接可信来源**。

## 4. iframe 通信

播放器发往父页面：

| 消息 | payload |
| --- | --- |
| `m3u-player:ready` | `{ count, groups, updatedAt }` |
| `m3u-player:change` | 当前节目信息 |
| `m3u-player:playing` | 当前播放信息 |
| `m3u-player:error` | `{ message, title }` |

父页面可以发：

```js
iframe.contentWindow.postMessage({ type: 'm3u-player:refresh' }, '*');
iframe.contentWindow.postMessage({ type: 'm3u-player:play', url: 'https://.../a.mp4' }, '*');
```

配置了 `parentOrigin` 后，双端都会校验/限定来源。

## 5. 静态资源与版本

推荐按 tag 锁定版本，避免播放器升级影响业务页面：

```text
https://cdn.jsdelivr.net/gh/AndrewGoal/m3u-player@v1.5/player/app.js
```

也可以直接用 Pages 上的最新文件：

```text
https://andrewgoal.github.io/m3u-player/player/app.js
```

## 6. 两个完整示例

- `examples/weather.html`：气象万千，Provider 实时生成 + 静态兜底
- `examples/iptv.html`：iframe + `?m3u=` 读取 `iptv.yang-1989.xyz/playlist.m3u`

## 7. 浏览器限制

- 播放列表本身必须允许 CORS（`Access-Control-Allow-Origin`），否则浏览器无法读取；Provider 不受此限制，因为文本是页面自己生成的。
- HLS 需要 hls.js 或浏览器原生支持；H.265 / AC-3 在多数桌面浏览器无法解码。
- HTTPS 页面里 `http://` 视频会被当作混合内容拦截；解析器会尝试升级到 https，但源站不支持时仍会失败。
