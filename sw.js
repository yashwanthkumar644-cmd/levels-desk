/* Offline support: keeps the app and its text reader on the phone after the first visit. */
const CACHE = "levels-desk-v3";
const FILES = [
  "./", "index.html", "engine.js", "reader.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "vendor/lightweight-charts.js", "vendor/tesseract.min.js", "vendor/worker.min.js",
  "vendor/core/tesseract-core-simd-lstm.wasm.js", "vendor/core/tesseract-core-lstm.wasm.js",
  "vendor/lang/eng.traineddata.gz",
];

const CORE = new Set(["./", "index.html", "engine.js", "reader.js"]); // without these the app can't open offline

async function addWithRetry(cache, file, tries = 3) {
  for (let n = 1; n <= tries; n++) {
    try { await cache.add(file); return true; } catch { await new Promise((r) => setTimeout(r, 500 * n)); }
  }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time: phones on slow connections cope better than with many large parallel downloads.
    for (const f of FILES) {
      const ok = await addWithRetry(cache, f);
      if (!ok && CORE.has(f)) throw new Error("could not save " + f); // install again on the next visit
      // Large files that failed are saved later, the first time the app loads them (see fetch below).
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// App files: cache first (works offline). Anything else (fonts): network, falling back to cache.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit && sameOrigin) return hit;
      return fetch(req).then((res) => {
        if (res.ok && (sameOrigin || req.destination === "font" || req.destination === "style")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit || Response.error());
    }),
  );
});
