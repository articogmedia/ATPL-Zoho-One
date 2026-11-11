const CACHE_NAME = "atpl-static-v2";
const STATIC_URLS = ["/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" || url.pathname.startsWith("/_next/data/")) {
    if (request.mode === "navigate") {
      event.respondWith(fetch(request).catch(() => new Response(
        "<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><title>Offline</title><main><h1>You are offline</h1><p>Reconnect and try again.</p></main>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      )));
    }
    return;
  }

  if (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/brand/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
