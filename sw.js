// Guarda o app e o motor de análise para funcionar sem internet.
const CACHE = "apneia-v12";   // só mexe nos caches "apneia-": o Projeto 1 (lobomau-) fica intocado
const CORE = ["./", "./index.html", "./core.js", "./app.js", "./manifest.webmanifest",
              "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("apneia-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.url.startsWith("blob:") || req.url.startsWith("data:")) return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // arquivos do app: tenta a versão nova (se houver internet), senão usa a guardada
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const guardada = async () => (await cache.match(req, { ignoreSearch: true })) ||
        (req.mode === "navigate" ? await cache.match("./index.html") : undefined);
      let res = null;
      try { res = await Promise.race([fetch(req), timeout(3000)]); } catch (err) { /* sem internet ou lento */ }
      if (res && res.ok) {                 // só aceita a versão da internet se ela veio certa
        cache.put(req, res.clone());
        return res;
      }
      // erro do site (ex.: 404 se o endereço sair do ar) ou sem internet: usa a cópia guardada
      return (await guardada()) || res || Response.error();
    })());
  } else {
    // motor de análise (CDN): baixa uma vez e guarda para sempre
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    })());
  }
});
