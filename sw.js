// sw.js: cache the app shell + phrases.json so the Phrases tab works offline.
// NEVER caches API calls: Supabase (REST, auth, edge functions) and OpenAI always go to the network.
const VERSION = "evc-v3";
const SHELL = ["./", "index.html", "styles.css", "app.js", "realtime.js", "gemini-live.js", "session-store.js", "config.js", "mock.js",
  "manifest.webmanifest", "phrases.json", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const CDN = "cdn.jsdelivr.net"; // the Supabase JS module: a static library, cached so the app shell boots offline

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function isApi(url) {
  return url.hostname.endsWith(".supabase.co") || url.hostname.endsWith("supabase.in") || url.hostname === "api.openai.com" || url.hostname === "generativelanguage.googleapis.com" ||
    url.pathname.includes("/functions/v1/") || url.pathname.includes("/rest/v1/") || url.pathname.includes("/auth/v1/");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POSTs (mint, grade, SDP) never touch the cache
  const url = new URL(req.url);
  if (isApi(url)) return;                           // straight to network
  if (url.pathname.includes("/eval/")) return;      // mock fixtures: always fresh
  if (url.origin === location.origin) {
    // Stale-while-revalidate for the shell; phrases.json included.
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || (req.mode === "navigate" ? c.match("index.html") : Response.error());
    }));
    return;
  }
  if (url.hostname === CDN) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then(r => { c.put(req, r.clone()); return r; })));
  }
});
