// 自毁式 Service Worker：清空 CacheStorage 并注销，绝不拦截任何网络请求
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        return caches.delete(name);
      }));
    }).then(function () {
      return self.registration.unregister();
    }).then(function () {
      return self.clients.matchAll();
    }).then(function (clients) {
      clients.forEach(function (client) {
        if (client.url && 'navigate' in client) {
          client.navigate(client.url);
        }
      });
    })
  );
});

// fetch 阶段直接穿透到网络，杜绝任何 NavigationRoute 劫持或缓存改写
self.addEventListener('fetch', function () {
  return;
});
