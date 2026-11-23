/**
 * 海纳百川-播放器的 Provider SDK。
 * 必须在 provider 脚本和 app.js 之前加载。
 */
(function (root) {
  'use strict';

  var api = root.M3UPlayer || (root.M3UPlayer = {});
  api.providers = api.providers || {};

  api.registerProvider = function (name, provider) {
    if (!name || typeof provider !== 'function') {
      throw new TypeError('registerProvider 需要名称和函数');
    }
    api.providers[name] = provider;
    return api;
  };

  api.getProvider = function (name) {
    return api.providers[name];
  };
})(typeof window !== 'undefined' ? window : globalThis);
