/**
 * 海纳百川-简洁播放器（原生播放版）
 *
 * 画面和声音都交给壳里的 ExoPlayer（SurfaceView 硬解），网页只画界面：
 *   左右键   快退 / 快进 10 秒（进度条短暂出现）
 *   上下键   当前分类里循环换台
 *   OK 键    播放 / 暂停
 *   菜单键   换源层（居中、半透明）
 *   返回键   关面板；没面板时连按两次退出
 *
 * 换源层：上下选源，OK 拉取该源（同一个源不重复拉取）并打开换台层。
 * 换台层：左边分类、右边频道，左右切栏、上下选择、OK 换台。
 */
(function () {
  'use strict';

  var Parser = window.PlaylistParser;
  var SDK = window.M3UPlayer;
  var SHELL = !!(window.TVShell && typeof window.TVShell.playerOpen === 'function');

  var params = new URLSearchParams(location.search);

  /* 和完整版共用同一套本地存储命名空间：完整版里加过的源，简洁版也能选 */
  var STORAGE_NS = 'm3u-player:default:';
  var SOURCES_KEY = STORAGE_NS + 'sources:v1';

  var WEATHER_M3U_URL = 'https://andrewgoal.github.io/cctv_weather_forecasting_m3u/cctv_weather_forecasting.m3u';
  var IPTV_M3U_URL = 'https://iptv.yang-1989.xyz/playlist.m3u';

  var BUILTIN_SOURCES = [
    { id: 'builtin:weather-live', label: '气象分析（无滞后，现取）', provider: 'weatherLive', builtin: true },
    { id: 'builtin:weather-file', label: '气象分析（或滞后，兜底）', url: WEATHER_M3U_URL, builtin: true },
    { id: 'builtin:iptv-file', label: '电视节目（国内外电视台）', url: IPTV_M3U_URL, builtin: true }
  ];

  var REFRESH_MS = 30 * 60 * 1000;

  var progressEl = document.getElementById('progress');
  var progressFill = document.getElementById('progressFill');
  var progressTime = document.getElementById('progressTime');
  var osdEl = document.getElementById('osd');
  var switchingEl = document.getElementById('switching');
  var switchingText = document.getElementById('switchingText');
  var switchingSpeed = document.getElementById('switchingSpeed');
  var infoEl = document.getElementById('infoPanel');
  var infoTitle = document.getElementById('infoTitle');
  var infoSub = document.getElementById('infoSub');
  var sourcePanel = document.getElementById('sourcePanel');
  var sourceList = document.getElementById('sourceList');
  var sourceHint = document.getElementById('sourceHint');
  var sourceLoading = document.getElementById('sourceLoading');
  var sourceLoadingText = document.getElementById('sourceLoadingText');
  var channelPanel = document.getElementById('channelPanel');
  var channelTitle = document.getElementById('channelTitle');
  var groupList = document.getElementById('groupList');
  var itemList = document.getElementById('itemList');

  var state = {
    sources: [],
    activeId: '',
    items: [],
    groups: [],
    current: null,
    source: null,
    loadedAt: 0,
    loading: false,
    playing: false,
    posMs: 0,
    durationMs: 0,
    pendingTitle: '',
    bandwidth: 0,
    infoKind: '',
    infoText: '',
    mode: 'video',        // video | sources | channels
    column: 'items',      // groups | items
    sourceIndex: 0,
    groupIndex: 0,
    itemIndex: 0
  };

  var panel = { groups: [], items: [], groupKey: null, groupsDirty: true };

  var progressTimer = 0;
  var osdTimer = 0;
  var bufferTimer = 0;
  var sourceLoadingTimer = 0;
  var watchdogTimer = 0;
  var switchingTimer = 0;
  var userPressed = false;

  /* ---------- 壳接口 ---------- */

  function shell(name) {
    if (!SHELL) return;
    try {
      var fn = window.TVShell[name];
      if (typeof fn === 'function') {
        if (arguments.length === 1) fn.call(window.TVShell);
        else fn.apply(window.TVShell, Array.prototype.slice.call(arguments, 1));
      }
    } catch (err) { /* 壳不在或调用失败都不该打断界面 */ }
  }

  /* ---------- 小工具 ---------- */

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* 忽略 */ }
  }

  function clock(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function osd(text, ms) {
    clearTimeout(osdTimer);
    if (!text) {
      osdEl.classList.remove('is-visible');
      return;
    }
    osdEl.textContent = text;
    osdEl.classList.add('is-visible');
    osdTimer = setTimeout(function () { osdEl.classList.remove('is-visible'); }, ms || 1800);
  }

  function showSwitching(text) {
    switchingText.textContent = text || '正在换台…';
    switchingEl.hidden = false;
    paintSpeed();
    clearTimeout(switchingTimer);
    switchingTimer = setTimeout(function () {
      if (switchingEl.hidden) return;
      switchingText.textContent = '这个源一直没有画面，换一个台试试';
      osd('这个源没有响应 · 上下键换台', 5000);
    }, 15000);
  }

  function hideSwitching() {
    clearTimeout(switchingTimer);
    switchingEl.hidden = true;
    if (switchingSpeed) switchingSpeed.textContent = '';
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond < 1) return '';
    var mbs = bytesPerSecond / 1048576;
    if (mbs < 0.01) return '小于0.01 MB/s';
    return mbs.toFixed(2) + ' MB/s';
  }

  function paintSpeed() {
    if (!switchingSpeed) return;
    if (switchingEl.hidden) {
      switchingSpeed.textContent = '';
      return;
    }
    switchingSpeed.textContent = formatSpeed(state.bandwidth) || '测速中……';
  }

  /** 常驻信息层：暂停、播不了都用它，直到用户操作。 */
  function renderInfo() {
    if (!state.infoKind) {
      infoEl.hidden = true;
      return;
    }
    infoTitle.textContent = state.current ? state.current.title : '';
    infoSub.textContent = state.infoText || '';
    infoSub.classList.toggle('is-error', state.infoKind === 'error');
    infoEl.classList.toggle('is-error-mode', state.infoKind === 'error');
    infoEl.hidden = false;
  }

  function showInfo(kind, text) {
    if (!state.current) return;
    state.infoKind = kind;
    state.infoText = text || '';
    renderInfo();
  }

  function hideInfo() {
    state.infoKind = '';
    state.infoText = '';
    infoEl.hidden = true;
  }

  /** 打开别的界面时先让位，但不丢状态 */
  function hideInfoVisual() {
    infoEl.hidden = true;
  }

  function restoreInfo() {
    if (state.infoKind) renderInfo();
  }

  function isHlsUrl(url) {
    return /\.m3u8(\?|#|$)/i.test(url || '');
  }

  /* ---------- 节目源 ---------- */

  function normalizeUrl(value) {
    try { return new URL(value, location.href).href; } catch (err) { return value; }
  }

  function loadSources() {
    var list = BUILTIN_SOURCES.map(function (source) { return Object.assign({}, source); });

    var saved = readJSON(SOURCES_KEY, []);
    if (Array.isArray(saved)) {
      saved.forEach(function (raw, index) {
        if (!raw || (!raw.url && !raw.provider)) return;
        if (list.some(function (s) { return (s.url && s.url === raw.url) || (s.provider && s.provider === raw.provider); })) return;
        list.push({
          id: raw.id || ('user:' + index),
          label: raw.label || ('自定义源 ' + (index + 1)),
          url: raw.url ? normalizeUrl(raw.url) : '',
          provider: raw.provider || '',
          custom: true
        });
      });
    }

    var custom = params.get('m3u');
    if (custom) {
      list.unshift({
        id: 'custom:url',
        label: '自定义 m3u',
        url: normalizeUrl(custom),
        custom: true
      });
    }
    return list;
  }

  function activeSource() {
    for (var i = 0; i < state.sources.length; i += 1) {
      if (state.sources[i].id === state.activeId) return state.sources[i];
    }
    return state.sources[0] || null;
  }

  function fetchText(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    var separator = url.indexOf('?') === -1 ? '?' : '&';

    return fetch(url + separator + '_=' + Date.now(), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text().then(function (text) {
        return { text: text, finalUrl: response.url || url };
      });
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function fetchSource(source) {
    if (!source) return Promise.reject(new Error('没有可用的节目源'));

    if (source.provider) {
      var provider = SDK && SDK.providers && SDK.providers[source.provider];
      if (typeof provider !== 'function') return Promise.reject(new Error('Provider 未注册：' + source.provider));
      return Promise.resolve()
        .then(function () { return provider(); })
        .then(function (result) {
          var data = result || {};
          if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Provider 返回内容为空');
          return { text: data.text, baseUrl: data.baseUrl || location.href };
        });
    }

    if (!source.url) return Promise.reject(new Error('节目源缺少地址'));
    return fetchText(source.url).then(function (result) {
      return { text: result.text, baseUrl: result.finalUrl || source.url };
    });
  }

  function parseItems(result) {
    if (/^\s*</.test(result.text)) throw new Error('返回的是网页而不是 m3u');
    var items = Parser.parseM3U(result.text, { baseUrl: result.baseUrl, now: new Date() });
    if (!items.length) throw new Error('没有解析到节目');
    return items;
  }

  function fetchWithFallback(source) {
    var order = [source].concat(state.sources.filter(function (s) { return s !== source; }));
    var errors = [];

    function attempt(index) {
      if (index >= order.length) return Promise.reject(errors[errors.length - 1] || new Error('所有节目源都失败了'));
      return fetchSource(order[index])
        .then(function (result) {
          return { source: order[index], items: parseItems(result) };
        })
        .catch(function (error) {
          errors.push(error);
          return attempt(index + 1);
        });
    }
    return attempt(0);
  }

  /** IPTV 那份列表的分类按倒序排：原来最后一条（台湾）排到最前，作为默认入口。 */
  function isIptvSource(source) {
    return !!source && source.id === 'builtin:iptv-file';
  }

  function buildGroups(source, items) {
    var groups = Parser.groupItems(items);
    if (isIptvSource(source)) groups.reverse();
    return groups;
  }

  function defaultItem(source) {
    if (isIptvSource(source) && state.groups.length) return state.groups[0].items[0];
    return state.items[0];
  }

  function applyItems(source, items, options) {
    var opts = options || {};
    state.source = source;
    state.items = items;
    state.groups = buildGroups(source, items);
    state.loadedAt = Date.now();

    var kept = opts.keep ? (findByUrl(state.current) || state.current) : null;
    state.current = kept || null;

    panel.groupsDirty = true;
    panel.groupKey = null;

    if (!state.current && opts.autoplay !== false) {
      play(defaultItem(source), { force: true });
    }

    if (state.mode === 'channels') {
      syncSelection();
      renderChannels();
    }
    renderSources();
  }

  function findByUrl(item) {
    if (!item) return null;
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].url === item.url) return state.items[i];
    }
    return null;
  }

  /* ---------- 播放（全部走原生 ExoPlayer） ---------- */

  function play(item, options) {
    var opts = options || {};
    if (!item) return;
    if (!SHELL) {
      osd('需要电视版才能播放', 3000);
      return;
    }

    var same = state.current && state.current.url === item.url;
    state.current = item;

    if (same && !opts.force) {
      if (!state.playing) shell('playerPlay');
      return;
    }

    state.posMs = 0;
    state.durationMs = 0;
    state.playing = false;
    hideInfo();
    showSwitching(item.title);
    state.pendingTitle = opts.silent ? '' : item.title;
    if (state.mode === 'channels') renderChannels();

    var url = item.playUrl || item.url;
    shell('playerOpen', url, isHlsUrl(url));

    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(function () {
      if (state.current && state.current.url === item.url && !state.playing) {
        hideSwitching();
        showInfo('error', '这个频道一直没有画面 · [▲▼] 上下键换台');
      }
    }, 20000);
  }

  function togglePlay() {
    userPressed = true;
    if (!SHELL) return;
    if (state.playing) shell('playerPause');
    else shell('playerPlay');
  }

  function seekBy(delta) {
    userPressed = true;
    if (!state.durationMs) {
      osd('直播流不支持快进', 1400);
      return;
    }
    var target = Math.max(0, Math.min(state.durationMs, state.posMs + delta * 1000));
    state.posMs = target;
    shell('playerSeek', Math.round(target));
    showProgress();
  }

  function currentGroupItems() {
    if (!state.current) return null;
    for (var i = 0; i < state.groups.length; i += 1) {
      if (state.groups[i].name === state.current.group) return state.groups[i].items;
    }
    return null;
  }

  /** 换台只在本分类里循环。 */
  function step(delta) {
    userPressed = true;
    if (!state.items.length) return;
    var pool = currentGroupItems() || state.items;
    var index = -1;
    for (var i = 0; i < pool.length; i += 1) {
      if (state.current && pool[i].url === state.current.url) { index = i; break; }
    }
    if (index === -1) index = delta > 0 ? -1 : 0;
    play(pool[(index + delta + pool.length) % pool.length]);
  }

  /* ---------- 进度条 ---------- */

  function updateProgress() {
    if (!state.durationMs) return;
    var ratio = Math.min(1, Math.max(0, state.posMs / state.durationMs));
    progressFill.style.width = (ratio * 100).toFixed(2) + '%';
    progressTime.textContent = clock(state.posMs / 1000) + ' / ' + clock(state.durationMs / 1000);
  }

  function showProgress() {
    if (!state.durationMs) {
      osd('直播流不支持快进', 1400);
      return;
    }
    updateProgress();
    progressEl.classList.add('is-visible');
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      progressEl.classList.remove('is-visible');
    }, 1600);
  }

  /* ---------- 换源层 ---------- */

  function renderSources() {
    sourceList.replaceChildren();
    state.sources.forEach(function (source, index) {
      var row = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = source.label;
      row.append(dot, label);

      if (source.id === state.activeId) {
        row.classList.add('is-current');
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = '当前';
        row.appendChild(sub);
      }
      if (state.mode === 'sources' && index === state.sourceIndex) row.classList.add('is-focus');

      row.addEventListener('click', function () {
        if (state.mode !== 'sources') return;
        state.sourceIndex = index;
        renderSources();
        selectSource();
      });

      sourceList.appendChild(row);
    });
  }

  /** 换源加载提示：转圈 + 台源名 + 秒数，告诉用户"在干活" */
  function beginSourceLoading(source) {
    sourceLoadingText.textContent = '正在拉取 ' + source.label + '…';
    sourceLoading.hidden = false;
    var started = Date.now();
    clearInterval(sourceLoadingTimer);
    sourceLoadingTimer = setInterval(function () {
      var seconds = Math.round((Date.now() - started) / 1000);
      sourceLoadingText.textContent = '正在拉取 ' + source.label + '… ' + seconds + ' 秒';
    }, 1000);
  }

  function endSourceLoading() {
    clearInterval(sourceLoadingTimer);
    sourceLoading.hidden = true;
  }

  function openSources() {
    osd('');
    hideInfoVisual();
    hideSwitching();
    state.mode = 'sources';
    state.sourceIndex = Math.max(0, state.sources.indexOf(activeSource()));
    renderSources();
    sourceHint.classList.remove('is-error');
    sourceHint.textContent = '上下选择 · OK 确认 · 返回关闭';
    sourcePanel.classList.add('is-visible');
    scrollToIndex(sourceList, state.sourceIndex);
  }

  function closePanels() {
    state.mode = 'video';
    sourcePanel.classList.remove('is-visible');
    channelPanel.classList.remove('is-visible');
    // 关掉面板后，如果还停着/还播不了，把信息层放回来
    restoreInfo();
  }

  function selectSource() {
    var source = state.sources[state.sourceIndex];
    if (!source || state.loading) return;

    // 没有切换源就不重复拉取，只把换台层打开
    if (source.id === state.activeId && state.items.length) {
      closePanels();
      openChannels();
      return;
    }

    state.loading = true;
    sourcePanel.classList.add('is-loading');
    sourceHint.classList.remove('is-error');
    sourceHint.textContent = '正在拉取 ' + source.label + '…';
    beginSourceLoading(source);

    fetchSource(source)
      .then(function (result) {
        var items = parseItems(result);
        state.activeId = source.id;
        state.loading = false;
        sourcePanel.classList.remove('is-loading');
        endSourceLoading();
        applyItems(source, items, { autoplay: true });
        closePanels();
        openChannels();
      })
      .catch(function (error) {
        state.loading = false;
        sourcePanel.classList.remove('is-loading');
        endSourceLoading();
        sourceHint.classList.add('is-error');
        sourceHint.textContent = '拉取失败：' + ((error && error.message) || '网络错误');
        osd('这个源拉不下来', 2000);
      });
  }

  /* ---------- 换台层（按键只切 class，不重建 DOM） ---------- */

  function groupItems() {
    var group = state.groups[state.groupIndex];
    return group ? group.items : [];
  }

  function syncSelection() {
    var groupIndex = 0;
    var itemIndex = 0;
    if (state.current) {
      for (var i = 0; i < state.groups.length; i += 1) {
        if (state.groups[i].name !== state.current.group) continue;
        groupIndex = i;
        for (var j = 0; j < state.groups[i].items.length; j += 1) {
          if (state.groups[i].items[j].url === state.current.url) { itemIndex = j; break; }
        }
        break;
      }
    }
    state.groupIndex = groupIndex;
    state.itemIndex = itemIndex;
  }

  function buildGroupRows() {
    groupList.replaceChildren();
    panel.groups = [];
    state.groups.forEach(function (group, index) {
      var row = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'dot';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = group.name;
      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = String(group.items.length);
      row.append(dot, label, sub);
      row.addEventListener('click', function () {
        if (state.mode !== 'channels') return;
        state.column = 'groups';
        state.groupIndex = index;
        state.itemIndex = 0;
        panel.groupKey = null;
        renderChannels();
      });
      groupList.appendChild(row);
      panel.groups.push(row);
    });
    panel.groupsDirty = false;
  }

  function buildItemRows() {
    var group = state.groups[state.groupIndex];
    var key = group ? group.name : '';
    if (panel.groupKey === key) return;
    panel.groupKey = key;
    itemList.replaceChildren();
    panel.items = [];
    (group ? group.items : []).forEach(function (item, index) {
      var row = document.createElement('li');
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.title;
      row.appendChild(label);
      if (item.duration) {
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = clock(item.duration);
        row.appendChild(sub);
      }
      row.addEventListener('click', function () {
        if (state.mode !== 'channels') return;
        state.column = 'items';
        state.itemIndex = index;
        confirmChannel();
      });
      itemList.appendChild(row);
      panel.items.push(row);
    });
    itemList.scrollTop = 0;
  }

  function scrollRow(list, row) {
    if (!row) return;
    var listRect = list.getBoundingClientRect();
    var rowRect = row.getBoundingClientRect();
    var pad = 10;
    if (rowRect.top < listRect.top + pad) {
      list.scrollTop -= listRect.top + pad - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom - pad) {
      list.scrollTop += rowRect.bottom - (listRect.bottom - pad);
    }
  }

  function scrollToIndex(list, index) {
    scrollRow(list, list.children[index]);
  }

  function paintChannels() {
    var group = state.groups[state.groupIndex];
    var current = state.current;
    var i;

    for (i = 0; i < panel.groups.length; i += 1) {
      var groupRow = panel.groups[i];
      groupRow.classList.toggle('is-selected', i === state.groupIndex);
      groupRow.classList.toggle('is-focus', i === state.groupIndex && state.column === 'groups');
      groupRow.classList.toggle('is-current', !!(current && current.group === state.groups[i].name));
    }

    for (i = 0; i < panel.items.length; i += 1) {
      var itemRow = panel.items[i];
      var item = group ? group.items[i] : null;
      itemRow.classList.toggle('is-selected', i === state.itemIndex);
      itemRow.classList.toggle('is-focus', i === state.itemIndex && state.column === 'items');
      itemRow.classList.toggle('is-playing', !!(current && item && current.url === item.url));
    }

    groupList.classList.toggle('is-focus', state.column === 'groups');
    itemList.classList.toggle('is-focus', state.column === 'items');
    channelTitle.textContent = '换台 · ' + (group ? group.name : '—');

    scrollToIndex(groupList, state.groupIndex);
    scrollToIndex(itemList, state.itemIndex);
  }

  function renderChannels() {
    if (panel.groupsDirty) buildGroupRows();
    buildItemRows();
    paintChannels();
  }

  function openChannels() {
    hideInfoVisual();
    hideSwitching();
    if (!state.groups.length) {
      osd('还没有节目', 1600);
      return;
    }
    osd('');
    state.mode = 'channels';
    state.column = 'items';
    syncSelection();
    panel.groupKey = null;
    renderChannels();
    channelPanel.classList.add('is-visible');
  }

  function moveSelection(delta) {
    if (state.column === 'groups') {
      var count = state.groups.length;
      if (!count) return;
      state.groupIndex = (state.groupIndex + delta + count) % count;
      state.itemIndex = 0;
      panel.groupKey = null;
      renderChannels();
      return;
    }
    var list = groupItems();
    if (!list.length) return;
    state.itemIndex = (state.itemIndex + delta + list.length) % list.length;
    paintChannels();
  }

  function confirmChannel() {
    if (state.column === 'groups') {
      state.column = 'items';
      paintChannels();
      return;
    }
    var item = groupItems()[state.itemIndex];
    if (!item) return;
    // 选中的就是当前正在播的台：没必要重新连接
    if (state.current && item.url === state.current.url && state.infoKind !== 'error') {
      closePanels();
      return;
    }
    closePanels();
    play(item, { force: true });
  }

  /* ---------- 按键 ---------- */

  /** 播不了的时候：OK / 左右只给一句提示，层不关；上下键照常换台。 */
  function errorKeys(code) {
    if (state.infoKind !== 'error') return false;
    if (code === 38 || code === 40) return false;
    if (code === 13 || code === 23 || code === 37 || code === 39) {
      osd('这个频道播不了 · [▲▼] 上下键换台', 2200);
      return true;
    }
    return true;
  }

  function videoKey(code) {
    switch (code) {
      case 13:
      case 23:
        togglePlay();
        return true;
      case 37:
        seekBy(-10);
        return true;
      case 39:
        seekBy(10);
        return true;
      case 38:
        step(-1);
        return true;
      case 40:
        step(1);
        return true;
      default:
        return false;
    }
  }

  function sourcesKey(code) {
    switch (code) {
      case 38:
        state.sourceIndex = (state.sourceIndex - 1 + state.sources.length) % state.sources.length;
        renderSources();
        scrollToIndex(sourceList, state.sourceIndex);
        return true;
      case 40:
        state.sourceIndex = (state.sourceIndex + 1) % state.sources.length;
        renderSources();
        scrollToIndex(sourceList, state.sourceIndex);
        return true;
      case 13:
      case 23:
        selectSource();
        return true;
      default:
        return false;
    }
  }

  function channelsKey(code) {
    switch (code) {
      case 38:
        moveSelection(-1);
        return true;
      case 40:
        moveSelection(1);
        return true;
      case 37:
        state.column = 'groups';
        paintChannels();
        return true;
      case 39:
        state.column = 'items';
        paintChannels();
        return true;
      case 13:
      case 23:
        confirmChannel();
        return true;
      default:
        return false;
    }
  }

  function toggleMenu() {
    userPressed = true;
    if (state.mode === 'video') openSources();
    else closePanels();
  }

  function onKeyDown(event) {
    var code = event.keyCode;
    var handled = false;

    if (code === 82 || code === 93) {
      toggleMenu();
      handled = true;
    } else if (code === 4 || code === 27) {
      handled = window.__simpleBack();
    } else if (state.mode === 'video') {
      handled = errorKeys(code) || videoKey(code);
    } else if (state.mode === 'sources') {
      handled = sourcesKey(code);
    } else {
      handled = channelsKey(code);
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  window.__simpleBack = function () {
    if (state.mode !== 'video') {
      closePanels();
      return true;
    }
    return false;
  };

  window.__simpleToast = function (text) {
    osd(text, 2200);
    return true;
  };

  window.__simpleKey = function (name) {
    switch (name) {
      case 'menu': toggleMenu(); break;
      case 'toggle': togglePlay(); break;
      case 'play': if (!state.playing) shell('playerPlay'); break;
      case 'pause': if (state.playing) shell('playerPause'); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'ff': seekBy(30); break;
      case 'rew': seekBy(-10); break;
      default: return false;
    }
    return true;
  };

  /* ---------- 原生播放器 → 页面 ---------- */

  window.__nativeEvent = function (type, value) {
    switch (type) {
      case 'ready':
        state.durationMs = value || 0;
        clearTimeout(watchdogTimer);
        break;
      case 'playing':
        state.playing = true;
        clearTimeout(bufferTimer);
        clearTimeout(watchdogTimer);
        hideInfo();
        hideSwitching();
        if (state.pendingTitle) {
          osd(state.pendingTitle, 1600);
          state.pendingTitle = '';
        }
        break;
      case 'paused':
        // 用户主动暂停：显示台名 + 按键说明（换台/缓冲过程中不弹）
        state.playing = false;
        if (switchingEl.hidden && state.mode === 'video') showInfo('pause', '已暂停');
        break;
      case 'ended':
        state.playing = false;
        step(1);
        break;
      case 'buffering':
        if (value) {
          clearTimeout(bufferTimer);
          // 卡住时不要弹「暂停」，而是把台名 + 网速摆出来，直到重新出画
          bufferTimer = setTimeout(function () {
            // 面板打开时不抢画面：换源/换台层自己会说明情况
            if (state.playing || state.mode !== 'video') return;
            showSwitching(state.current ? state.current.title : '正在缓冲…');
          }, 1200);
        } else {
          clearTimeout(bufferTimer);
          if (!state.playing && state.mode === 'video') hideSwitching();
        }
        break;
      case 'error':
        state.playing = false;
        clearTimeout(watchdogTimer);
        hideSwitching();
        showInfo('error', '这个频道播不了 · [▲▼] 上下键换台');
        break;
      default:
        break;
    }
  };

  window.__nativeTick = function (position, duration, playing, bytesPerSecond) {
    state.posMs = position || 0;
    if (duration) state.durationMs = duration;
    state.playing = !!playing;
    if (typeof bytesPerSecond === 'number') state.bandwidth = bytesPerSecond;
    if (progressEl.classList.contains('is-visible')) updateProgress();
    paintSpeed();
  };

  document.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('keydown', onKeyDown, true);

  /* ---------- 启动 ---------- */

  function boot() {
    progressEl.hidden = false;
    osdEl.hidden = false;
    sourcePanel.hidden = false;
    channelPanel.hidden = false;
    infoEl.hidden = true;

    if (!Parser || !SDK) {
      showSwitching('播放器脚本加载失败');
      return;
    }

    if (!SHELL) {
      // 没有壳就没有原生播放器，这套界面用不了
      showSwitching('请用「气象分析」电视版打开');
      return;
    }

    document.documentElement.classList.add('native');
    showSwitching('正在加载…');

    state.sources = loadSources();
    // 每次启动都从第一个源开始（?m3u= 时优先临时源），不记忆上次的
    state.activeId = params.get('m3u')
      ? 'custom:url'
      : (state.sources[0] ? state.sources[0].id : '');

    renderSources();
    var source = activeSource();
    if (!source) {
      hideSwitching();
      osd('没有可用的节目源', 4000);
      return;
    }

    fetchWithFallback(source)
      .then(function (result) {
        state.activeId = result.source.id;
        applyItems(result.source, result.items, { autoplay: true });
      })
      .catch(function (error) {
        hideSwitching();
        osd('播放列表加载失败：' + ((error && error.message) || '网络错误'), 5000);
      });

    setInterval(function () {
      if (document.hidden || !state.items.length || !state.source) return;
      if (Date.now() - state.loadedAt < REFRESH_MS) return;
      fetchSource(state.source)
        .then(function (result) {
          applyItems(state.source, parseItems(result), { keep: true });
        })
        .catch(function () { /* 静默失败 */ });
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
