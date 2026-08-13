// ---------- Room image loading: concurrency-limited + client-side cached ----------
// With hundreds of imaged rooms, switching to a layer that shows them all would otherwise
// fire that many requests at the image host near-simultaneously (HTTP/2 has no hard
// per-origin connection cap, so the browser won't naturally stagger these). This module:
//   1. Caps how many image loads are in flight at once (MAX_CONCURRENT), queuing the rest.
//   2. Best-effort caches successful fetches in the Cache Storage API, so repeat views
//      (including after a reload) don't re-hit the remote server at all.
// The cache step requires the image host to allow cross-origin fetch (CORS); if it doesn't,
// the fetch throws and we fall back to the raw URL, which still displays fine via CSS
// background-image (that never needed CORS) — we just don't get our own persistent cache
// for that particular image. Staggering still applies either way.
const CACHE_NAME = "mush-map-images-v1";
const MAX_CONCURRENT = 4;

const resolved = new Map();   // remote url -> usable src (cached blob: URL, or the raw url as fallback)
const queue = [];
let active = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    load(job.url).then(job.resolve).finally(() => { active--; pump(); });
  }
}

async function load(url) {
  let src = url;
  try {
    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      let res = await cache.match(url);
      if (!res) {
        res = await fetch(url, { mode: "cors" });
        if (res.ok) await cache.put(url, res.clone());
      }
      if (res.ok) src = URL.createObjectURL(await res.blob());
    }
  } catch (e) {
    // CORS-blocked or network error — src stays the raw URL (see module comment above).
  }
  // Wait for it to actually be decodable before resolving, so callers stagger *display*
  // (not just the cache lookup) — otherwise a `background-image` set from a not-yet-loaded
  // blob/URL would just pop in whenever the browser gets to it, defeating the point.
  await new Promise(done => {
    const img = new Image();
    img.onload = done; img.onerror = done;
    img.src = src;
  });
  resolved.set(url, src);
  return src;
}

// Queues a room image load behind the concurrency limit; resolves with a src ready to
// assign to `el.style.backgroundImage`. Safe to call repeatedly for the same URL.
export function loadRoomImage(url) {
  if (resolved.has(url)) return Promise.resolve(resolved.get(url));
  return new Promise(resolve => { queue.push({ url, resolve }); pump(); });
}

export async function clearImageCache() {
  for (const src of resolved.values()) if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  resolved.clear();
  if ("caches" in window) await caches.delete(CACHE_NAME);
}

// Reports how many images are actually persisted in Cache Storage and their total size —
// a direct, honest check that caching is working (as opposed to just trusting the code).
export async function getImageCacheStats() {
  if (!("caches" in window) || !(await caches.has(CACHE_NAME))) return { count: 0, bytes: 0 };
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  let bytes = 0;
  for (const key of keys) {
    const res = await cache.match(key);
    const len = res && res.headers.get("content-length");
    bytes += len ? parseInt(len, 10) : (res ? (await res.clone().blob()).size : 0);
  }
  return { count: keys.length, bytes };
}
