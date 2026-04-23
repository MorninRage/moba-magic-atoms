/**
 * Tiny IndexedDB key-value cache for procedural-generation outputs.
 *
 * **Why:** procedural LPCA pipelines (forest scatter, heightfield, mesh
 * generation) produce deterministic outputs from small parameter sets. Caching
 * the output keyed by a content-hash of the inputs lets a second visit skip
 * the compute entirely — typical wins are −500 ms to −2 s on warm boots
 * depending on what's cached. Pairs with `navigator.storage.persist()` (set
 * up in `persistentCache.ts`) so the cache survives storage pressure.
 *
 * **Design constraints:**
 *  - **Zero deps.** ~120 LOC, no `idb-keyval` / `dexie` / etc. — every byte
 *    in the main bundle counts during preload.
 *  - **Transferable-friendly.** Stores `ArrayBuffer` + `Uint8Array` natively,
 *    plus JSON-serializable values via implicit `structuredClone`. No double-
 *    serialization tax for typed-array geometry data.
 *  - **Best-effort.** Every operation is `Promise<T | null>` — IDB unavailable,
 *    quota full, version conflict, transaction abort — all return `null`
 *    gracefully so the call site falls through to compute-on-miss.
 *  - **Single shared store.** One DB (`moba-magic-atoms-cache`) + one object store
 *    (`procedural-v1`). Suffix the version on cache-key migrations rather
 *    than bumping the store name.
 *
 * **Usage pattern:**
 * ```ts
 * import { idbGetCached, idbPut, hashCacheKey } from '../util/idbCache';
 *
 * const key = await hashCacheKey({ seed: 1234, biome: 'forest', radius: 90 });
 * let scatterSpecs = await idbGetCached<ScatterSpec[]>(`forest-scatter:${key}`);
 * if (!scatterSpecs) {
 *   scatterSpecs = await computeForestScatter(...);  // expensive
 *   void idbPut(`forest-scatter:${key}`, scatterSpecs);
 * }
 * // ... build geometry from scatterSpecs ...
 * ```
 *
 * **Caller responsibilities:**
 *  - **Hash inputs deterministically.** Use `hashCacheKey` for plain JS values
 *    (it serializes via `JSON.stringify` with sorted keys + SHA-256). Don't
 *    hash Three.js objects — extract the parameters that drove their creation.
 *  - **Bump the cache-key prefix on schema changes.** If the shape of the
 *    cached value changes (e.g. `ScatterSpec` gains a field), bump from
 *    `forest-scatter:` to `forest-scatter-v2:` so old caches are silently
 *    ignored. Old entries get evicted at the natural LRU rate; no migration
 *    code needed.
 *  - **Don't await the put.** `idbPut` is fire-and-forget — chain the
 *    consumer's first paint on the compute result, write to IDB after.
 *
 * @see docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md (research Tier 2.12)
 */

const DB_NAME = 'moba-magic-atoms-cache';
const DB_VERSION = 1;
const STORE_NAME = 'procedural-v1';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      /* If the browser blows the database away mid-session (quota crunch,
       * user clears storage), `onversionchange` fires and our handle becomes
       * unusable — drop the cached promise so the next call re-opens. */
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      resolve(null);
    };
    req.onblocked = () => {
      /* Another tab has an older DB version open. Resolve null + try again
       * later; not worth blocking boot on. */
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Read a cached value by key. Returns `null` on cache miss, IDB unavailable,
 * or any read error. Type parameter is asserted, NOT validated — caller must
 * trust their cache-key prefix.
 */
export async function idbGetCached<T = unknown>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, 'readonly');
    } catch {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

/**
 * Write a value into the cache. Fire-and-forget — call sites should `void`
 * this after their compute result is already feeding the consumer. Returns
 * `true` on successful write, `false` otherwise (informational only).
 *
 * Quota errors silently degrade to `false` — the call site continues with
 * its computed value as if nothing had happened.
 */
export async function idbPut(key: string, value: unknown): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/**
 * Drop a cached entry by key. Use after detecting that a cached value is
 * stale via a separate signal (e.g. content-hash mismatch on the underlying
 * spec). Returns `true` on success, `false` otherwise.
 */
export async function idbDelete(key: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/**
 * Stable JSON serialization with sorted keys. Used to feed `hashCacheKey` so
 * `{a: 1, b: 2}` and `{b: 2, a: 1}` produce the same hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}

/**
 * Hash a JSON-serializable params object into a short hex string suitable
 * for use as a cache-key suffix. Uses `crypto.subtle.digest('SHA-256', ...)`
 * when available, falls back to a simple FNV-1a 32-bit hash otherwise (tiny
 * collision risk — fine for cache keys, not for security).
 *
 * Not deterministic across major JS runtimes for `Map` / `Set` / class
 * instances — caller must pass plain JS objects + arrays + primitives only.
 */
export async function hashCacheKey(params: unknown): Promise<string> {
  const stable = stableStringify(params);
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const bytes = new TextEncoder().encode(stable);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const view = new Uint8Array(digest);
      let hex = '';
      for (let i = 0; i < 12; i++) {
        const b = view[i] ?? 0;
        hex += b.toString(16).padStart(2, '0');
      }
      return hex;
    } catch {
      /* fall through to FNV */
    }
  }
  /* FNV-1a 32-bit fallback. Plenty of collision resistance for cache keys. */
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
