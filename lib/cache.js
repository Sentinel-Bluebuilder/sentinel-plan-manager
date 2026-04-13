// ─── Cache Layer ─────────────────────────────────────────────────────────────
// Generic TTL cache with inflight deduplication and stale fallback.
// Pattern: returns cached data if fresh, deduplicates concurrent fetches,
// falls back to stale data on error.

const _cache = {};

/**
 * Fetch data with TTL caching and inflight deduplication.
 *
 * @param {string} key - Unique cache key
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @param {Function} fetchFn - Async function that returns data
 * @returns {Promise<*>} Cached or freshly fetched data
 */
export function cached(key, ttlMs, fetchFn) {
  const entry = _cache[key];
  if (entry && (Date.now() - entry.ts) < ttlMs) return Promise.resolve(entry.data);

  // Deduplicate concurrent requests for the same key
  if (entry?.inflight) return entry.inflight;

  const p = fetchFn().then(data => {
    _cache[key] = { data, ts: Date.now(), inflight: null };
    return data;
  }).catch(err => {
    if (_cache[key]) _cache[key].inflight = null;
    // Stale fallback — return old data instead of throwing
    if (entry?.data) return entry.data;
    throw err;
  });

  _cache[key] = { ...(entry || {}), inflight: p };
  return p;
}

/**
 * Invalidate a cache entry by key.
 * Use after mutations (TX broadcast) to ensure fresh data on next read.
 *
 * @param {string} key - Cache key to invalidate
 */
export function cacheInvalidate(key) {
  delete _cache[key];
}

/**
 * Clear all cache entries. Useful for wallet logout.
 */
export function cacheClear() {
  for (const key of Object.keys(_cache)) delete _cache[key];
}
