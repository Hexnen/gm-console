/**
 * gm-console service worker — offline shell only.
 *
 * Scope of the job, deliberately small: keep the console's own files (HTML, CSS,
 * the haptics module, the PWA manifest and icon) available when the tablet is
 * installed and the relay is briefly unreachable, so the app opens to its own UI
 * instead of the browser's dinosaur. It is NOT an offline mode: without the relay
 * there is no board and nothing to fire.
 *
 * The single hard rule below is that /api/* is never touched. Everything the
 * console actually does — the SSE stream, pairing, firing, layout saves — lives
 * there, and a cached answer to any of it is worse than no service worker at
 * all. A cached /api/events in particular would replay one dead stream forever
 * while the dot stayed green: a silent, unexplainable failure.
 *
 * Registered from index.html; registration is allowed to fail (it always does
 * over plain http, which is not a secure context) and the page works unchanged.
 */

/**
 * Bump on every shell change. The name is the whole cache-busting mechanism:
 * activate() deletes every cache that is not this one, so an old shell cannot
 * outlive a deploy.
 */
const CACHE = "gm-console-shell-v1";

/**
 * The shell, and nothing else. Macro icons come from Foundry on another origin
 * and change with the world; caching them here would pin a stale library and
 * grow without bound.
 */
const SHELL = [
  "/",
  "/liquid-glass.css",
  "/haptics.mjs",
  "/manifest.webmanifest",
  "/icon.svg"
];

/**
 * Is this a request the worker must keep its hands off entirely?
 *
 * Answering false here means "fall through to the network untouched" — no
 * respondWith at all, so the browser handles it exactly as if no worker were
 * installed. That is the correct outcome for everything except the shell.
 * @param {Request} req
 * @param {URL} url
 */
function isBypass(req, url) {
  // Anything the relay treats as API: auth, presence, firing, and the SSE
  // stream. Must always reach the network, and must never be stored.
  if ( url.pathname.startsWith("/api/") ) return true;
  // Belt and braces for the stream: EventSource requests announce themselves,
  // so even a future endpoint outside /api/ cannot be swallowed by accident.
  if ( req.headers.get("accept")?.includes("text/event-stream") ) return true;
  // Only GET is ever cacheable, and only our own origin is ours to serve.
  if ( req.method !== "GET" ) return true;
  if ( url.origin !== self.location.origin ) return true;
  return false;
}

/**
 * Map a request to the cache key it was precached under.
 *
 * A navigation can arrive as "/", "/index.html", or "/?pair=ABC123" — the pairing
 * deep link from the QR code. All three are the same document, and the query is
 * consumed by the page rather than by the relay, so they collapse onto "/".
 * @param {Request} req
 * @param {URL} url
 * @returns {string|null} Cache key, or null if this is not part of the shell.
 */
function shellKey(req, url) {
  if ( req.mode === "navigate" ) return "/";
  if ( url.pathname === "/index.html" ) return "/";
  return SHELL.includes(url.pathname) ? url.pathname : null;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually rather than addAll(): addAll is all-or-nothing, so one asset
    // missing after a partial deploy would leave the console with no worker at
    // all rather than a worker missing one file.
    await Promise.all(SHELL.map(async path => {
      try {
        const res = await fetch(path, { cache: "reload" });
        if ( res.ok ) await cache.put(path, res);
      } catch { /* offline at install time; activate() still proceeds */ }
    }));
    // The console is a single page a GM leaves open for a whole session. A
    // waiting worker would sit there until the tab is closed, which may be
    // days — so a new version takes over immediately instead.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n === CACHE) ? null : caches.delete(n)));
    // Control the already-open page too, so the first load after registration
    // is not left uncontrolled until a reload.
    //
    // Note there is deliberately no controllerchange -> location.reload() dance
    // on the page side: the running document keeps the JS it booted with until
    // the GM reloads. Yanking the console out from under a live session to pick
    // up a CSS tweak is worse than being one version behind for an hour.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if ( isBypass(req, url) ) return;

  const key = shellKey(req, url);
  if ( !key ) return;                    // not the shell — let the network have it

  /*
   * Network-first, cache as fallback.
   *
   * Cache-first would be faster, but the relay and this page ship together: a
   * cache-first shell would keep running yesterday's index.html against today's
   * relay until the worker itself updated. On a LAN the network leg costs
   * milliseconds, so freshness is the better trade and the cache exists purely
   * for the moment the relay is down.
   *
   * The relay sends every static file with `Cache-Control: no-store`. That stops
   * the *HTTP* cache from holding anything — which is why this fetch is always a
   * real one and never a stale hit — but Cache Storage is explicit storage and
   * is not bound by it, so cache.put below still works. The same header is why a
   * redeploy is seen promptly: the browser's periodic update check re-fetches
   * sw.js for real every time instead of being served a copy of itself for up to
   * 24 hours, so a bumped CACHE constant lands on the next visit.
   */
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Only store a genuine success. Caching the relay's own 500 ("index.html
      // missing from public/") would make a transient deploy error permanent.
      if ( res.ok ) {
        const cache = await caches.open(CACHE);
        await cache.put(key, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(key);
      if ( cached ) return cached;
      // No network and nothing cached: a plain error is more honest than a
      // fabricated page, and the browser shows its own offline UI.
      throw new Error("offline and not cached");
    }
  })());
});
