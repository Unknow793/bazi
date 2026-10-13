// 网络优先：每次加载都取最新文件（开发期方便），离线时回退到缓存。
const CACHE = "bazi-v4";
const URLS = [
    "./index.html",
    "./lunar.js",
    "./bazi_params.js",
    "./cities.js",
    "./bazi_engine.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png",
    "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(URLS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    if (e.request.method !== "GET") return;
    e.respondWith(
        fetch(e.request, { cache: "no-store" }).then((resp) => {
            if (resp.ok) {
                const clone = resp.clone();
                caches.open(CACHE).then((cache) => cache.put(e.request, clone));
            }
            return resp;
        }).catch(() =>
            caches.match(e.request).then((cached) => cached || caches.match("./index.html"))
        )
    );
});
