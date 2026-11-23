/* ==========================================================================
   海纳百川-播放器 · PWA 增强
   - 注册 Service Worker（离线可用）
   - 新版本就绪提示
   - “安装到桌面”入口（桌面 / Android / iOS）
   ========================================================================== */

(function () {
  'use strict';

  var standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  var embedded = window.parent !== window;
  var isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ---------------- Service Worker ---------------- */

  if ('serviceWorker' in navigator && !embedded) {
    window.addEventListener('load', function () {
      navigator.serviceWorker
        .register('sw.js', { scope: './' })
        .then(function (registration) {
          if (registration.waiting && navigator.serviceWorker.controller) {
            showUpdatePill(registration.waiting);
          }
          registration.addEventListener('updatefound', function () {
            var worker = registration.installing;
            if (!worker) return;
            worker.addEventListener('statechange', function () {
              if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                showUpdatePill(worker);
              }
            });
          });
        })
        .catch(function (err) {
          if (window.console && console.warn) console.warn('Service Worker 注册失败：', err);
        });
    });
  }

  function showUpdatePill(worker) {
    if (document.getElementById('pwaUpdate')) return;

    var pill = document.createElement('div');
    pill.id = 'pwaUpdate';
    pill.className = 'pwa-update';
    pill.setAttribute('role', 'status');

    var label = document.createElement('span');
    label.textContent = '新版本已就绪';

    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '立即刷新';

    pill.appendChild(label);
    pill.appendChild(button);
    document.body.appendChild(pill);
    requestAnimationFrame(function () {
      pill.classList.add('is-visible');
    });

    button.addEventListener('click', function () {
      button.disabled = true;
      label.textContent = '正在更新…';
      var done = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (done) return;
        done = true;
        location.reload();
      });
      if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(function () {
        if (done) return;
        done = true;
        location.reload();
      }, 1800);
    });
  }

  /* ---------------- 安装到桌面 ---------------- */

  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    injectInstallItem();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var item = document.getElementById('pwaInstallBtn');
    if (item && item.parentNode) item.parentNode.removeChild(item);
  });

  if (isIOS && !standalone && !embedded) {
    injectInstallItem();
  }

  function injectInstallItem() {
    if (standalone || embedded) return;
    var menu = document.getElementById('moreMenu');
    if (!menu || document.getElementById('pwaInstallBtn')) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'pwaInstallBtn';
    button.setAttribute('role', 'menuitem');
    button.textContent = isIOS ? '添加到主屏幕（分享菜单）' : '安装到桌面';

    button.addEventListener('click', function () {
      closeMenu();
      if (isIOS && !deferredPrompt) {
        flash('在 Safari 中点「分享」→「添加到主屏幕」即可安装');
        return;
      }
      if (!deferredPrompt) return;
      var prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      if (prompt.userChoice) prompt.userChoice.then(function () {}).catch(function () {});
    });

    menu.insertBefore(button, menu.firstChild);
  }

  function closeMenu() {
    var menu = document.getElementById('moreMenu');
    var moreBtn = document.getElementById('moreBtn');
    if (menu) menu.hidden = true;
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  }

  function flash(message) {
    var toastEl = document.getElementById('toast');
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.dataset.kind = 'info';
    toastEl.hidden = false;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(flash._timer);
    flash._timer = setTimeout(function () {
      if (toastEl.textContent !== message) return;
      toastEl.classList.remove('is-visible');
      setTimeout(function () {
        if (toastEl.textContent === message) toastEl.hidden = true;
      }, 240);
    }, 4200);
  }
})();
