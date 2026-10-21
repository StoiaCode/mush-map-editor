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
//   3. Stores a shrunk copy, not the original: tiles show at most 82px × 2.5 zoom (≈410 device
//      px on a high-DPI screen), cropped square, so the short side is capped at SHRINK_PX and
//      re-encoded as WebP. The inspector preview loads the original URL itself, at full size.
const CACHE_NAME = "mush-map-images-v1";
const MAX_CONCURRENT = 4;
const SHRINK_PX = 440, SHRINK_Q = 0.8;
const SHRUNK = "x-mm-shrunk";   // header on cache entries that are already the small copy

// A smaller WebP copy of `blob` as a cacheable Response, or null when it wouldn't save anything.
async function shrink(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, SHRINK_PX / Math.min(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await new Promise(done => c.toBlob(done, "image/webp", SHRINK_Q));
    if (!out || out.type !== "image/webp") return null;   // browser can't encode WebP
    return new Response(out.size < blob.size ? out : blob,
      { headers: { "content-type": out.size < blob.size ? out.type : blob.type, "content-length": String(Math.min(out.size, blob.size)), [SHRUNK]: "1" } });
  } catch (e) {
    return null;   // not decodable as an image: keep whatever we have
  }
}

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
        if (res.ok) res = (await shrink(await res.clone().blob())) || res;
        if (res.ok) await cache.put(url, res.clone());
      } else if (!res.headers.get(SHRUNK)) {
        // cached before shrinking existed: swap in the small copy
        const small = await shrink(await res.clone().blob());
        if (small) { await cache.put(url, small.clone()); res = small; }
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
// assign to `el.style.backgroundImage`. Safe to call repeatedly for the same URL: every
// render() asks again for every tile's image, and the live link renders on each move, so a
// load still in flight is shared rather than queued again behind copies of itself.
const pending = new Map();    // remote url -> promise of a load that's queued or running
export function loadRoomImage(url) {
  if (resolved.has(url)) return Promise.resolve(resolved.get(url));
  if (pending.has(url)) return pending.get(url);
  const p = new Promise(resolve => { queue.push({ url, resolve }); pump(); })
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}

export async function clearImageCache() {
  for (const src of resolved.values()) if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  resolved.clear();
  if ("caches" in window) await caches.delete(CACHE_NAME);
}

// Shrinks everything cached before shrinking existed, one image at a time, so images on layers
// you don't open also get smaller. Runs once per page load, a little after startup.
async function shrinkOldEntries() {
  if (!("caches" in window) || !(await caches.has(CACHE_NAME))) return;
  const cache = await caches.open(CACHE_NAME);
  for (const key of await cache.keys()) {
    const res = await cache.match(key);
    if (!res || res.headers.get(SHRUNK)) continue;
    const small = await shrink(await res.blob());
    if (small) await cache.put(key, small);
  }
}
setTimeout(() => { shrinkOldEntries().catch(() => {}); }, 5000);

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
