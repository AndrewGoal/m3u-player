/**
 * 海纳百川-播放器 · TV 模式
 *
 * 给遥控器（D-pad）用的外壳：
 *   - 方向键在按钮之间做几何空间导航，Enter 触发，Back 逐层退出
 *   - 视频区自绘控制条（原生 <video controls> 不认遥控器）
 *   - 列表重绘后把焦点还回去，栏目切换不会把焦点丢到 body
 *   - 媒体键（播放/暂停/上一台/下一台）与快进快退
 *
 * 默认只在电视上启用：?tv=1 强制开启，?tv=0 强制关闭。
 * 不改变任何手机 / 桌面端行为。
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var params = new URLSearchParams(location.search);

  function isTv() {
    var forced = params.get('tv');
    if (forced === '1' || forced === 'true') return true;
    if (forced === '0' || forced === 'false') return false;
    var cfg = window.M3U_PLAYER_CONFIG;
    if (cfg && cfg.tv) return true;
    if (window.location.hash === '#tv') return true;
    var ua = navigator.userAgent || '';
    return /Android TV|Google ?TV|Smart-?TV|BRAVIA|AFT[A-Z0-9]|MiBOX|MiTV|RBOX|TV ?Box|H96|X96|T95/i.test(ua);
  }

  if (!isTv()) {
    window.__tvKey = function () { return false; };
    window.__tvBack = function () { return false; };
    return;
  }

  root.classList.add('tv');

  var KEY = {
    BACK: 4,
    ENTER: 13,
    DPAD_CENTER: 23,
    ESC: 27,
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    MEDIA_STOP: 86,
    MEDIA_PLAY_PAUSE: 85,
    MEDIA_NEXT: 87,
    MEDIA_PREV: 88,
    MEDIA_REW: 89,
    MEDIA_FF: 90,
    MEDIA_PLAY: 126,
    MEDIA_PAUSE: 127,
    // Chromium 把 Android 媒体键映射成 Windows 虚拟键码，两边都收
    MEDIA_NEXT_TRACK: 176,
    MEDIA_PREV_TRACK: 177,
    MEDIA_STOP_VK: 178,
    MEDIA_PLAY_PAUSE_VK: 179
  };

  var video = null;
  var searchInput = null;
  var wrap = null;
  var listEl = null;
  var bar = null;
  var barTimer = 0;
  var osdEl = null;
  var osdTimer = 0;
  var lastListFocus = null;

  /* ---------- 工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function isDisabled(el) {
    return !el || el.disabled || el.getAttribute('aria-hidden') === 'true';
  }

  function isVisible(el) {
    if (!el || isDisabled(el)) return false;
    if (el.closest('[hidden]')) return false;
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function focusables() {
    var nodes = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]');
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el.getAttribute('tabindex') === '-1' && !el.matches('input, textarea, select')) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /** 焦点进入滚动容器后就地滚一下，别让选中项跑出屏幕。 */
  function revealFocus(el) {
    if (!el) return;
    var box = el.closest('.list, .chips, .source-items');
    if (!box) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    var boxRect = box.getBoundingClientRect();
    var rect = el.getBoundingClientRect();
    var pad = 8;
    if (rect.top < boxRect.top + pad) {
      box.scrollTop -= boxRect.top + pad - rect.top;
    } else if (rect.bottom > boxRect.bottom - pad) {
      box.scrollTop += rect.bottom - (boxRect.bottom - pad);
    }
    if (rect.left < boxRect.left + pad) {
      box.scrollLeft -= boxRect.left + pad - rect.left;
    } else if (rect.right > boxRect.right - pad) {
      box.scrollLeft += rect.right - (boxRect.right - pad);
    }
  }

  /**
   * 几何空间导航：在给定方向上找“最正对”的可聚焦元素。
   * 主方向距离优先，垂直方向偏移加权惩罚。
   */
  function spatial(direction) {
    var current = document.activeElement;
    if (!current || current === document.body) return null;
    var source = current.getBoundingClientRect();
    var sx = source.left + source.width / 2;
    var sy = source.top + source.height / 2;
    var best = null;
    var bestScore = Infinity;
    var candidates = focusables();
    var vertical = direction === 'up' || direction === 'down';

    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (el === current || el.contains(current) || current.contains(el)) continue;
      // 控制条上的上/下不回到整块播放器，否则会和控制条互相锁死
      if (el === wrap && bar && bar.contains(current)) continue;
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var dx = x - sx;
      var dy = y - sy;
      var primary;
      var secondary;
      var overlap;

      if (direction === 'up') {
        if (dy > -6) continue;
        primary = Math.max(0, source.top - rect.bottom);
        secondary = Math.abs(dx);
        overlap = !(rect.right < source.left - 8 || rect.left > source.right + 8);
      } else if (direction === 'down') {
        if (dy < 6) continue;
        primary = Math.max(0, rect.top - source.bottom);
        secondary = Math.abs(dx);
        overlap = !(rect.right < source.left - 8 || rect.left > source.right + 8);
      } else if (direction === 'left') {
        if (dx > -6) continue;
        primary = Math.max(0, source.left - rect.right);
        secondary = Math.abs(dy);
        overlap = !(rect.bottom < source.top - 8 || rect.top > source.bottom + 8);
      } else {
        if (dx < 6) continue;
        primary = Math.max(0, rect.left - source.right);
        secondary = Math.abs(dy);
        overlap = !(rect.bottom < source.top - 8 || rect.top > source.bottom + 8);
      }

      // 比“边缘间距”为主、“错位距离”为辅：上键优先走同一列，避免莫名跳到搜索框
      var score = primary + secondary * 1.5 + (overlap ? 0 : 4000);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function moveFocus(direction) {
    var current = document.activeElement;
    // 节目单里按左键，直接回播放器，而不是先跳回栏目标签
    var inList = current && current.closest && current.closest('#list');
    // 列表在屏幕最右边，按右键不该跳回上面的栏目标签
    if (direction === 'right' && inList) return false;
    var target = (direction === 'left' && inList && wrap) ? wrap : spatial(direction);
    if (!target) return false;
    target.focus({ preventScroll: true });
    revealFocus(target);
    if (bar && !bar.contains(target) && barShown()) scheduleHideBar();
    return true;
  }

  /* ---------- 反馈 ---------- */

  function osd(text) {
    if (!osdEl) {
      osdEl = document.createElement('div');
      osdEl.className = 'tv-osd';
      document.body.appendChild(osdEl);
    }
    osdEl.textContent = text;
    osdEl.classList.add('is-visible');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () {
      osdEl.classList.remove('is-visible');
    }, 1200);
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

  /* ---------- 控制条 ---------- */

  function barShown() {
    return !!bar && !bar.hidden;
  }

  function showBar() {
    if (!bar) return;
    bar.hidden = false;
    updateBar();
    scheduleHideBar();
  }

  function hideBar() {
    if (!bar) return;
    clearTimeout(barTimer);
    if (bar.contains(document.activeElement)) return;
    bar.hidden = true;
  }

  function scheduleHideBar() {
    clearTimeout(barTimer);
    barTimer = setTimeout(hideBar, 6000);
  }

  function updateBar() {
    if (!bar || !video) return;
    var toggle = bar.querySelector('[data-act="toggle"]');
    var progress = bar.querySelector('.tv-progress');
    var fill = bar.querySelector('.tv-progress-fill');
    var time = bar.querySelector('.tv-time');
    if (toggle) toggle.textContent = video.paused ? '▶ 播放' : '❚❚ 暂停';

    var live = !isFinite(video.duration) || video.duration <= 0;
    if (progress) progress.hidden = live;
    if (time) time.hidden = live;
    if (!live) {
      var ratio = Math.min(1, Math.max(0, video.currentTime / video.duration));
      if (fill) fill.style.width = (ratio * 100).toFixed(2) + '%';
      if (time) time.textContent = clock(video.currentTime) + ' / ' + clock(video.duration);
    }
  }

  /** 焦点在播放器上（视频区 / 控制条之外的空白） */
  function onPlayerSurface(el) {
    if (!el || el === document.body) return true;
    return el === video || el === wrap || (!!wrap && wrap.contains(el) && el === wrap);
  }

  function clickId(id) {
    var el = $(id);
    if (el && !el.disabled) el.click();
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) {
      video.play().catch(function () { osd('无法播放，试试下一个'); });
      osd('▶ 播放');
    } else {
      video.pause();
      osd('❚❚ 暂停');
    }
  }

  function seek(seconds) {
    if (!video) return;
    if (!isFinite(video.duration) || video.duration <= 0) return false;
    var target = Math.min(video.duration, Math.max(0, video.currentTime + seconds));
    video.currentTime = target;
    osd((seconds > 0 ? '快进 ' : '快退 ') + Math.abs(seconds) + ' 秒 · ' + clock(target));
    updateBar();
    return true;
  }

  function changeVolume(delta) {
    if (!video) return;
    var next = Math.min(1, Math.max(0, video.volume + delta));
    video.volume = next;
    if (next > 0 && video.muted) video.muted = false;
    osd('音量 ' + Math.round(next * 100) + '%');
  }

  /** 影院模式：只留视频。比 Fullscreen API 稳，WebView 里也能立刻生效。 */
  function toggleTheater() {
    var on = root.classList.toggle('tv-theater');
    var btn = bar && bar.querySelector('[data-act="fs"]');
    if (btn) btn.textContent = on ? '退出影院' : '全屏';
    osd(on ? '影院模式 · 按返回键退出' : '已退出影院模式');
    if (!on) {
      var active = listEl && listEl.querySelector('.item.is-active');
      if (active) active.focus({ preventScroll: true });
    }
    return on;
  }

  function onBarClick(event) {
    var btn = event.target.closest('[data-act]');
    if (!btn) return;
    event.stopPropagation();
    switch (btn.dataset.act) {
      case 'prev': clickId('prevBtn'); osd('上一个'); break;
      case 'next': clickId('nextBtn'); osd('下一个'); break;
      case 'toggle': togglePlay(); break;
      case 'vol-down': changeVolume(-0.1); break;
      case 'vol-up': changeVolume(0.1); break;
      case 'fs': toggleTheater(); break;
      default: break;
    }
    showBar();
  }

  function buildBar() {
    if (!wrap || bar) return;
    bar = document.createElement('div');
    bar.className = 'tv-bar';
    bar.hidden = true;
    bar.innerHTML = '' +
      '<div class="tv-bar-row">' +
      '<button type="button" class="tv-btn" data-act="prev">⏮ 上一台</button>' +
      '<button type="button" class="tv-btn tv-btn-main" data-act="toggle">▶ 播放</button>' +
      '<button type="button" class="tv-btn" data-act="next">下一台 ⏭</button>' +
      '<div class="tv-progress" hidden><span class="tv-progress-fill"></span></div>' +
      '<span class="tv-time" hidden>--:--</span>' +
      '<button type="button" class="tv-btn" data-act="vol-down">音量 −</button>' +
      '<button type="button" class="tv-btn" data-act="vol-up">音量 +</button>' +
      '<button type="button" class="tv-btn" data-act="fs">全屏</button>' +
      '</div>';
    bar.addEventListener('click', onBarClick);
    wrap.appendChild(bar);
  }

  /* ---------- 遥控器按键 ---------- */

  function mediaAction(code) {
    switch (code) {
      case KEY.MEDIA_PLAY: return 'play';
      case KEY.MEDIA_PAUSE: case KEY.MEDIA_STOP: case KEY.MEDIA_STOP_VK: return 'pause';
      case KEY.MEDIA_PLAY_PAUSE: case KEY.MEDIA_PLAY_PAUSE_VK: return 'toggle';
      case KEY.MEDIA_NEXT: case KEY.MEDIA_NEXT_TRACK: return 'next';
      case KEY.MEDIA_PREV: case KEY.MEDIA_PREV_TRACK: return 'prev';
      case KEY.MEDIA_FF: return 'ff';
      case KEY.MEDIA_REW: return 'rew';
      default: return '';
    }
  }

  function media(action) {
    switch (action) {
      case 'play': if (video) video.play().catch(function () {}); showBar(); break;
      case 'pause': if (video) video.pause(); osd('❚❚ 暂停'); break;
      case 'toggle': togglePlay(); showBar(); break;
      case 'next': clickId('nextBtn'); osd('下一个'); break;
      case 'prev': clickId('prevBtn'); osd('上一个'); break;
      case 'ff': if (!seek(30)) clickId('nextBtn'); break;
      case 'rew': if (!seek(-10)) clickId('prevBtn'); break;
      default: break;
    }
    updateBar();
  }

  function back() {
    if (root.classList.contains('tv-theater')) {
      toggleTheater();
      if (wrap) wrap.focus({ preventScroll: true });
      return true;
    }
    if (barShown()) {
      if (bar.contains(document.activeElement) && wrap) wrap.focus({ preventScroll: true });
      bar.hidden = true;
      return true;
    }
    var menu = $('moreMenu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      return true;
    }
    var search = $('search');
    if (search && document.activeElement === search) {
      search.blur();
      var active = listEl && listEl.querySelector('.item.is-active');
      if (active) active.focus();
      return true;
    }
    if (osdEl) osdEl.classList.remove('is-visible');
    return false;
  }

  function onEnter(event) {
    var current = document.activeElement;
    if (onPlayerSurface(current)) {
      var overlay = $('overlay');
      var bigPlay = $('bigPlay');
      if (overlay && !overlay.classList.contains('is-hidden') && bigPlay) {
        bigPlay.click();
      } else {
        togglePlay();
      }
      event.preventDefault();
      return;
    }
    if (current === searchInput && searchInput.hasAttribute('readonly')) {
      // 遥控器把焦点移到搜索框时不要立刻弹输入法：按 OK 再解锁
      searchInput.removeAttribute('readonly');
      searchInput.focus();
      event.preventDefault();
      return;
    }
    if (/^(input|textarea|select)$/i.test(current.tagName)) return;
    if (current.matches('button, a[href], [role="menuitem"], .switch')) {
      event.preventDefault();
      current.click();
    }
  }

  function onKey(event) {
    var action = mediaAction(event.keyCode);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      media(action);
      return;
    }

    if (event.keyCode === KEY.ESC || event.keyCode === KEY.BACK) {
      if (back()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    var current = document.activeElement;
    var typing = current && (/^(input|textarea|select)$/i.test(current.tagName) || current.isContentEditable);

    if (event.keyCode === KEY.ENTER || event.keyCode === KEY.DPAD_CENTER) {
      if (!typing) {
        event.stopPropagation();
        onEnter(event);
        if (event.defaultPrevented) event.stopPropagation();
      }
      return;
    }

    if (typing) {
      // 输入框里左右键移动光标；上下键直接离开输入框，否则遥控器会被困在里面
      if (event.keyCode === KEY.UP || event.keyCode === KEY.DOWN) {
        event.preventDefault();
        event.stopPropagation();
        var leaveTo = spatial(event.keyCode === KEY.UP ? 'up' : 'down');
        if (current.blur) current.blur();
        if (leaveTo) {
          leaveTo.focus({ preventScroll: true });
          revealFocus(leaveTo);
        }
      }
      return;
    }

    if (event.keyCode !== KEY.UP && event.keyCode !== KEY.DOWN &&
        event.keyCode !== KEY.LEFT && event.keyCode !== KEY.RIGHT) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (onPlayerSurface(current)) {
      if (event.keyCode === KEY.UP || event.keyCode === KEY.DOWN) {
        showBar();
        var toggle = bar.querySelector('[data-act="toggle"]');
        if (toggle) toggle.focus();
        return;
      }
      var forward = event.keyCode === KEY.RIGHT;
      var seconds = forward ? 10 : -10;
      if (!seek(seconds)) {
        clickId(forward ? 'nextBtn' : 'prevBtn');
        osd(forward ? '下一个' : '上一个');
      }
      showBar();
      return;
    }

    if (bar && bar.contains(current)) {
      if (event.keyCode === KEY.DOWN || event.keyCode === KEY.UP) {
        if (!moveFocus(event.keyCode === KEY.DOWN ? 'down' : 'up')) {
          if (event.keyCode === KEY.DOWN) {
            bar.hidden = true;
            var active = listEl && (listEl.querySelector('.item.is-active') || listEl.querySelector('.item'));
            if (active) { active.focus(); revealFocus(active); }
          }
        }
      } else {
        moveFocus(event.keyCode === KEY.RIGHT ? 'right' : 'left');
      }
      showBar();
      return;
    }

    moveFocus(event.keyCode === KEY.UP ? 'up' : event.keyCode === KEY.DOWN ? 'down'
      : event.keyCode === KEY.LEFT ? 'left' : 'right');
    if (barShown() && !bar.contains(document.activeElement)) scheduleHideBar();
  }

  /* ---------- 列表重绘后恢复焦点 ---------- */

  function focusListItem() {
    if (!listEl) return null;
    var target = listEl.querySelector('.item.is-active') || listEl.querySelector('.item');
    if (!target) return null;
    target.focus({ preventScroll: true });
    revealFocus(target);
    lastListFocus = target;
    return target;
  }

  function watchList() {
    document.addEventListener('focusin', function (event) {
      if (listEl && listEl.contains(event.target)) lastListFocus = event.target;
    }, true);

    // app.js 每次筛选/刷新都会重建整个列表，焦点会掉回 body。
    // 这里把焦点还给同一个节目，找不到就还给第一个。
    var observer = new MutationObserver(function () {
      var active = document.activeElement;
      var lost = !active || active === document.body || active === listEl;
      if (!lost) return;
      if (!lastListFocus) {
        focusListItem();
        return;
      }
      var id = lastListFocus.dataset ? lastListFocus.dataset.id : '';
      var next = id ? listEl.querySelector('.item[data-id="' + cssEscape(id) + '"]') : null;
      next = next || listEl.querySelector('.item.is-active') || listEl.querySelector('.item');
      if (next) {
        next.focus({ preventScroll: true });
        revealFocus(next);
        lastListFocus = next;
      }
    });
    observer.observe(listEl, { childList: true });
  }

  /* ---------- 节目源面板压成一行 ---------- */

  function compactSources() {
    var form = document.querySelector('#sourcePanel .source-add');
    if (!form || form.dataset.tvCompact === '1') return;
    form.dataset.tvCompact = '1';
    form.hidden = true;

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chip tv-source-add';
    toggle.textContent = '＋ 节目源';
    var items = form.parentNode.querySelector('.source-items');
    if (items) items.appendChild(toggle);
    else form.parentNode.insertBefore(toggle, form);
    toggle.addEventListener('click', function () {
      form.hidden = !form.hidden;
      toggle.textContent = form.hidden ? '＋ 节目源' : '收起';
      if (!form.hidden) {
        var input = form.querySelector('input');
        if (input) input.focus();
      }
    });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    video = $('video');
    if (video) video.controls = false;
    wrap = document.querySelector('.player-wrap');
    if (wrap) {
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('aria-label', '播放器：确认键播放或暂停，左右键快进或切换频道');
    }
    searchInput = $('search');
    if (searchInput) {
      // 焦点经过搜索框时不弹输入法，按 OK 才进入输入
      searchInput.setAttribute('readonly', 'readonly');
      searchInput.addEventListener('blur', function () {
        searchInput.setAttribute('readonly', 'readonly');
      });
    }
    listEl = $('list');

    if (!video || !listEl) return;

    buildBar();
    if (wrap) wrap.addEventListener('focus', showBar);
    compactSources();
    watchList();

    video.addEventListener('play', function () { updateBar(); scheduleHideBar(); });
    video.addEventListener('pause', updateBar);
    video.addEventListener('timeupdate', updateBar);
    // 切台后新视频还没起播，别把上一个节目的进度留在控制条上
    video.addEventListener('loadstart', function () {
      if (bar) {
        var fill = bar.querySelector('.tv-progress-fill');
        if (fill) fill.style.width = '0%';
        var time = bar.querySelector('.tv-time');
        if (time) time.textContent = '--:--';
      }
      updateBar();
    });
    video.addEventListener('loadedmetadata', updateBar);
    video.addEventListener('volumechange', function () {
      if (video.muted || video.volume === 0) osd('静音');
    });

    // 首次进入：把焦点放到正在播的那一条，遥控器一按就有反应
    setTimeout(function () {
      var active = document.activeElement;
      if (!active || active === document.body) focusListItem();
    }, 1200);

    // 屏幕右下角不再需要鼠标悬停提示
    document.body.classList.add('tv-ready');
  }

  window.addEventListener('keydown', onKey, true);

  window.__tvKey = function (name) {
    media(name);
    return true;
  };

  window.__tvBack = function () {
    return back();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
