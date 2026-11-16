// 彻底注销与清除所有 Service Worker 和 CacheStorage 缓存，防止导航劫持
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (var i = 0; i < registrations.length; i++) {
      registrations[i].unregister();
    }
  }).catch(function () {});
}
if (typeof window !== 'undefined' && 'caches' in window) {
  caches.keys().then(function (names) {
    for (var j = 0; j < names.length; j++) {
      caches.delete(names[j]);
    }
  }).catch(function () {});
}
