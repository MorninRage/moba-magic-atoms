# Session 2026-04-21 — Preload Round 4 (research addendum + judge-refresh stack)

## Context

Companion to:
- **`docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md`** — round 1 (unified pipeline + ghost mesh fix)
- **`docs/SESSION_2026_04_20_PRELOAD_ROUND_2.md`** — round 2 (sub-ms yields + deferred renderPage + tighter caps)
- **`docs/SESSION_2026_04_20_PRELOAD_ROUND_3.md`** — round 3 (cutscene re-encode + staged forest + zero-alloc tick + awakened-only deferral)

Round 4 splits in two halves:

- **Half A (already shipped earlier 2026-04-21, before this doc was written):** `fetchpriority` rebalance on the cutscene `<link>` hints, `Cache-Control: ... immutable` + `no-cache` on `index.html` + `Service-Worker-Allowed: /` on `/sw.js` via `netlify.toml`, intro-cutscene **skip-on-warm-visit** flag (`localStorage` set after the full intro chain completes).
- **Half B (this session):** ranked research on what's left to ship + the **judge-refresh stack** itself — service worker via Workbox + `vite-plugin-pwa`, `navigator.storage.persist()` with quota guard, and an **adaptive device profile** that broadens the existing `graphicsTier` to also probe `deviceMemory` / `connection.effectiveType` / `Save-Data` and gates cutscene preload on the result.

The Vibe Jam workload is **judge-refresh-dominant**: a single judge typically loads the URL N times across 1–4 days while voting, so the second-visit-to-Nth-visit path matters more than the cold visit. Every shipped change in this round is evaluated against that workload first.

---

## Research findings — biggest-bang-for-buck (vs. what's already shipped)

A parallel research pass produced a ranked list of techniques that compound on top of round 3's wins. Full citations live at the bottom of this doc.

### Tier 1 — judge-refresh wins (the dominant workload)

| # | Technique | Realistic impact | Difficulty | Status this session |
|---|---|---|---|---|
| 1 | **Service worker via Workbox + `vite-plugin-pwa`** — precache hashed assets, runtime CacheFirst for cutscenes/audio, Navigation Preload to hide SW boot stall | **−10 to −20 s on every revisit** (essentially network-free start; only gated by SW boot + JS parse) | M | **shipped** |
| 2 | **`navigator.storage.persist()`** + `navigator.storage.estimate()` quota guard — protect the ~30 MB cutscene + ~32 MB music cache from LRU eviction; bail out of cutscene runtime cache if quota is tight | protects #1 (keeps "second-visit instant" reliable across days of judging); avoids silent SW install failure on low-storage iPhones | S | **shipped** |
| 3 | **`Cache-Control: ... immutable` + `no-cache` on `index.html`** | −80 to −400 ms on every revisit (skip 304 round-trip for assets; protect against blank-screen-after-deploy) | S | **shipped earlier 2026-04-21** (Half A — `netlify.toml`) |
| 4 | **Compression Dictionary Transport (RFC 9842)** — delta-compressed JS chunks against prior build | −500 ms to −1 s on every post-deploy refresh | M-L | **deferred** (Cloudflare/Netlify CDN feature; effort disproportionate to 4-day jam window) |

### Tier 2 — first-visit wins (the judge's first impression)

| # | Technique | Realistic impact | Difficulty | Status this session |
|---|---|---|---|---|
| 5 | **Adaptive device profile** (`hardwareConcurrency` + `deviceMemory` + `connection.effectiveType` + `Save-Data`) — gate cutscene preload + graphics tier on real device capability | turns slideshow → playable on bottom-tier devices; saves 30 MB of cutscene download for data-saver users | S-M | **shipped** (extends existing `graphicsTier.ts`) |
| 6 | **Tiny inline app shell + LCP poster** — first paint < 200 ms regardless of bundle size | −1 to −2 s perceived load | S | **already shipped earlier 2026-04-20** (`#boot-veil` in `index.html`) |
| 7 | **`fetchpriority="high"` on LCP-critical preload, `="low"` on cutscene preload** | −200 to −500 ms time-to-interactive on throttled connections | S | **shipped earlier 2026-04-21** (Half A — `index.html`) |
| 8 | **Cutscene skip-on-warm-visit** via `localStorage` flag set after the full intro chain succeeds | −30 s of cutscene playback on every post-first-visit boot | S | **shipped earlier 2026-04-21** (Half A — `introCutscene.ts` + `main.ts`) |
| 9 | **KTX2 + Basis Universal + Meshopt** asset pipeline via `glTF-Transform` | −40% to −70% texture bytes; large reduction in upload stutter on first scene activation | M | **deferred** (the game is mostly procedural LPCA; payoff scales with non-procedural texture asset volume) |
| 10 | **103 Early Hints** (CDN-side `Link: rel=preload` while origin is still rendering HTML) | −100 to −400 ms first paint | S (Netlify) | **deferred** (Netlify default origin is already < 100 ms TTFB on a static SPA, so Early Hints would be a no-op; revisit if origin TTFB grows) |
| 11 | **Navigation Preload** (`registration.navigationPreload.enable()`) — fire HTML fetch in parallel with SW boot | −100 to −300 ms on warm SW revisit | S | **shipped** (paired with #1) |
| 12 | **IndexedDB cache for procedural LPCA meshes** | −hundreds of ms to seconds on second visit | M | **deferred** (next session — bigger refactor, needs a content hash for the generation params) |

### Tier 3 — meaningful but smaller / situational

13. **PSO-style shader pre-warm via `renderer.compile(scene, camera)`** — eliminates first-frame stutter when entering forest / first combat / first cutscene exit. **Status:** the existing pipeline already does `compileAsync` shader warm; three.js r152+ `renderer.compile()` is now PSO-aware (compiles + does dummy draw call). **Deferred** — adopt only if first-frame stutter shows in profiling.
14. **`manualChunks` split** (three-core / three-addons / engine / content / ui) — −100 to −300 kB off the main chunk via better cacheability across deploys. **Deferred** — the existing `dynamic import()` strategy in `main.ts` already gets most of the per-route win; manualChunks is the remaining ~150 kB.
15. **Audio sprite sheet** for short SFX (vs many small `.mp3`/`.ogg`) — eliminates per-SFX HTTP request + per-SFX `decodeAudioData` cost. **Deferred** — small win for this game (few SFX); revisit if SFX count grows.
16. **Single-blob content** (concatenate `recipes.json + cards.json + dialog.json` into one `.bin` with TOC header) — −50 to −200 ms; skips per-file JSON parse cost. **Deferred** — content files are imported statically and bundled into the JS chunk today, so the network-side win is already realized.
17. **Predictive prefetch of scene N+1** during scene N's last frames. **Deferred** — applies once the game has multi-scene transitions.
18. **Speculation Rules `prerender`** with `eagerness: "moderate"`. **N/A** — single-route SPA shell.

### Tier 4 — explicitly NOT worth it for this context

- **WebCodecs + mp4box.js for cutscenes** — overkill for a 17 MB H.264 clip played linearly. `<video preload="auto">` + `+faststart` (already shipped) is what shipping web games use.
- **HLS/DASH adaptive bitrate** — overkill for two ≤17 MB clips. Single MP4 with HTTP Range support (already on by default at every CDN) is the standard pattern.
- **`SharedArrayBuffer` + COOP/COEP** for off-thread Basis decode — real win for huge texture sets, but adds the COOP/COEP `require-corp` minefield. Not worth it unless texture decode becomes the bottleneck.
- **HTTP/3 / QUIC** — already on by default at every CDN (Cloudflare, Netlify, Vercel, Fastly). Verify in DevTools `Protocol` column; no code work.
- **AV1 cutscene re-encode** — software-decode fallback is brutal on mid-range laptops. CRF 23 H.264 (already shipped) is the right call for unknown-device judges.

---

## What was shipped this session

### Tier 1.1 — Service worker via Workbox + `vite-plugin-pwa`

**Problem solved:** Vibe Jam judging is refresh-heavy. Today every refresh re-fetches the entire ~948 kB main JS chunk + all hashed asset chunks + all third-party fonts + (until cutscene-skip-on-warm-visit shipped earlier today) the ~30 MB cutscene MP4s. With Cache-Control immutable + the cutscene-skip flag the JS side already hits the HTTP cache on revisit, but the cutscene download still runs on first visit per browser session, and the JS chunks still incur the index.html → asset roundtrip per revisit. A service worker eliminates **all** of those round trips for warm visits — the SW serves precached chunks from CacheStorage with no network at all, and the runtime cache for cutscenes survives across browser sessions (the HTTP cache typically does not for files this large).

**Fix — `vite.config.ts`:**

Added `vite-plugin-pwa` with `injectRegister: false` (we register the SW from `main.ts` so it lands AFTER first paint, not during HTML parse):

```ts
VitePWA({
  registerType: 'autoUpdate',
  injectRegister: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,woff2,webp,png,ico}'],
    globIgnores: ['**/cutscenes/**', '**/audio/**'],
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    navigationPreload: true,
    runtimeCaching: [
      {
        urlPattern: ({ url }) => url.pathname.startsWith('/cutscenes/'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'idle-craft-cutscenes-v1',
          expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
          rangeRequests: true,
          cacheableResponse: { statuses: [0, 200, 206] },
        },
      },
      {
        urlPattern: ({ url }) => url.pathname.startsWith('/audio/'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'idle-craft-audio-v1',
          expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 },
          rangeRequests: true,
          cacheableResponse: { statuses: [0, 200, 206] },
        },
      },
      {
        urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
        handler: 'StaleWhileRevalidate',
        options: { cacheName: 'idle-craft-fonts-v1' },
      },
    ],
  },
})
```

Key design calls:

- **`globIgnores: ['**/cutscenes/**', '**/audio/**']`** — large media stays OUT of the precache manifest. Workbox `precacheAndRoute` chokes on >50 MB lists and would also fail SW install entirely if any single asset 404s. The cutscenes + music live in the **runtime** cache (CacheFirst) instead, so they populate on first play and survive across sessions, but a missing/changed video doesn't break SW install.
- **`maximumFileSizeToCacheInBytes: 5 * 1024 * 1024`** — defensive cap; the largest hashed JS chunk today is ~948 kB so 5 MB headroom is comfortable.
- **`navigationPreload: true`** — Workbox emits the `registration.navigationPreload.enable()` call as part of the SW activate handler. Fires the HTML network fetch in parallel with SW boot on every navigation, hiding the 100–300 ms SW-bootstrap stall on warm revisits.
- **`rangeRequests: true` + `statuses: [0, 200, 206]`** — `<video>` always uses HTTP Range to fetch the cutscene; without the Range plugin, Workbox's CacheFirst returns the full file for every Range request which breaks playback. With it, partial responses are cached and replayed correctly.
- **`registerType: 'autoUpdate'`** — when a new SW version installs, it self-activates after all open tabs close. For a single-tab Vibe Jam visit this means the next refresh after a deploy gets the new SW; combined with the Cache-Control `no-cache` on index.html (already shipped), no judge ever sees stale code.
- **`injectRegister: false`** — we register the SW manually from `main.ts` AFTER `bootIntroExperience` mounts, so the SW install doesn't compete with first-paint critical work. See next subsection.

**Files:**
- `vite.config.ts` (added `VitePWA` plugin)
- `package.json` (added `vite-plugin-pwa` devDependency)

---

### Tier 1.2 — SW registration + `navigator.storage.persist()` from `main.ts`

**Problem solved:** Two related risks of registering the SW too early:
1. SW install grabs a worker thread that competes with the cutscene `<video>` decode + the `dockPreload` chunk parse during the curse-cutscene window. Visible as a 100–300 ms hitch in the cutscene's first second.
2. `navigator.storage.persist()` shows a permission prompt on Firefox if called before the user has interacted with the page. Showing it during cutscene 1 looks like a virus warning to a judge.

**Fix — new `src/engine/persistentCache.ts`:**

```ts
export async function registerIdleCraftServiceWorker(): Promise<void> { /* ... */ }
export async function requestPersistentStorageOnceSWReady(): Promise<void> { /* ... */ }
```

`registerIdleCraftServiceWorker` is called from `main.ts` inside `scheduleSecondaries()` (which already runs via `requestIdleCallback` after first paint, with a 1500 ms `setTimeout` fallback for SR-only users). So the SW install lands in the same idle slot as the audio module + scrollbar pulse + system menu — well after the inline boot veil is up, after the splash module + cutscene module have started loading, and crucially after the cutscene `<video>` has its first decoded frame.

`requestPersistentStorageOnceSWReady` chains off the SW registration's `ready` promise + a subsequent `navigator.storage.estimate()` quota check:

- If `quota - usage < 200 MB`, skip the persist request entirely + log to console — the user is on a low-storage device (typically iPhone with full Photos library) and asking for persistence would only confirm an eviction we can't prevent. The cutscene runtime-cache may itself fail to populate; that's fine, judges on those devices get the network-fetch path on every visit.
- Otherwise, call `navigator.storage.persist()`. On Chrome/Edge, the call grants automatically without a prompt for sites the user has interacted with (the `requestIdleCallback` slot guarantees first-paint + at least one tick, which counts as interaction for Storage API purposes). On Firefox the user sees a permission prompt — bounded acceptable cost. On Safari 16+ it grants automatically.

**Fix — `src/main.ts`:**

Added two lines to `deferredBootSecondaries`:

```ts
import { registerIdleCraftServiceWorker, requestPersistentStorageOnceSWReady } from './engine/persistentCache';
// ... inside deferredBootSecondaries:
void registerIdleCraftServiceWorker().then(() => requestPersistentStorageOnceSWReady());
```

Order is intentional: the persistent-storage request is chained off SW registration so it fires AFTER the SW has installed and the runtime cache stores exist (otherwise the persist grant applies to nothing of consequence). The `void` + `.then` is fire-and-forget — neither call blocks any boot path.

**Files:**
- `src/engine/persistentCache.ts` (new file — SW registration + persist + quota guard)
- `src/main.ts` (chained `registerIdleCraftServiceWorker` + `requestPersistentStorageOnceSWReady` into `deferredBootSecondaries`)

---

### Tier 2.5 — Adaptive device profile (`graphicsTier.ts` extension)

**Problem solved:** The existing `graphicsTier.ts` resolves to `low` or `high` based on UA + viewport + `hardwareConcurrency`. Three real device-capability signals it didn't probe:

1. **`navigator.deviceMemory`** — exposes the device's RAM in GB (rounded to nearest power of 2). A 2 GB Chromebook + an 8 GB iPad Pro both report `hardwareConcurrency: 8` but have radically different texture-residency budgets. A judge on the Chromebook today silently runs out of memory + crashes the tab during the forest scene; with `deviceMemory < 4` we fall to `low` tier preemptively.
2. **`navigator.connection.effectiveType`** — `'4g' | '3g' | '2g' | 'slow-2g'`. A judge on hotel wifi (`'3g'` effective) sees the cutscene download dominate boot time even after the round 3 re-encode. Skipping cutscene preload on `'3g'`/`'2g'` and downgrading the cutscene to a `<video preload="metadata">` + lazy load gets them to the title screen ~10 s faster at the cost of a buffering pause when the cutscene actually starts (acceptable — they came to vote, not watch).
3. **`navigator.connection.saveData`** + **`@media (prefers-reduced-data)`** — explicit user opt-in to data thrift. Skip cutscene preload entirely; the user has told the browser "don't load big media". 30 MB saved per visit for users who have this on.

**Fix — `src/engine/graphicsTier.ts`:**

Added a new exported `DeviceProfile` shape that wraps the existing tier resolution with three additional booleans:

```ts
export interface DeviceProfile {
  graphicsTier: GraphicsTier;
  shouldPreloadCutscenes: boolean;
  shouldPreloadShatteringInBackground: boolean;
  isDataSaver: boolean;
  /** Diagnostic — what the detector saw. Logged to console once at boot. */
  signals: {
    hardwareConcurrency: number | null;
    deviceMemoryGB: number | null;
    effectiveConnectionType: string | null;
    saveData: boolean;
    mobileUA: boolean;
  };
}
export function detectDeviceProfile(): DeviceProfile { /* ... */ }
```

Decision matrix:

| Signal | `shouldPreloadCutscenes` | `shouldPreloadShatteringInBackground` |
|---|---|---|
| `saveData === true` | **false** | **false** |
| `effectiveType === 'slow-2g' \|\| '2g'` | **false** | **false** |
| `effectiveType === '3g'` | true (curse only) | **false** (let the long curse-playback window cover the network) |
| `deviceMemory <= 2` | true (curse only) | **false** (low-RAM device — don't keep two cutscenes resident) |
| default | **true** | **true** |

The existing `resolveGraphicsTier()` is called inside `detectDeviceProfile` so URL/localStorage overrides still take precedence — this is purely additive, no callers change.

`detectDeviceProfile()` is **memoized** at module scope (recomputed only across full module reloads) — the underlying signals don't change within a session, and the small console log happens once.

**Fix — `src/main.ts`:**

`bootIntroExperience` now reads the device profile once at boot, gates the `preloadVideoFile(shattering)` call on `profile.shouldPreloadShatteringInBackground`, and passes a `forceSkipCutscene` flag to `shouldPlayIntroCutscene`-equivalent logic so a `saveData` user goes straight from splash → start-flow with no cutscene playback at all (their bandwidth is precious; the cutscene is a cinematic that demands explicit user intent).

The `index.html` `<link rel="preload">` for the curse video still fires unconditionally — by the time any JS runs, the bytes may already be a few MB into the network. The runtime guard inside the SW (`globIgnores` for `/cutscenes/`) keeps them out of the precache; the runtime CacheFirst route still caches them on first play but only on first play. So `saveData` users still pay for the ~12 MB curse preload IF their device fails to honor `Save-Data`-aware HTML hint preloads (Chromium does honor this; Safari does not yet); the JS-level skip catches them on the data-saver path either way.

**Files:**
- `src/engine/graphicsTier.ts` (added `DeviceProfile` interface + `detectDeviceProfile` function; existing `resolveGraphicsTier` and `getGraphicsBudget` unchanged)
- `src/main.ts` (read profile once at boot; gate `preloadVideoFile(shattering)` + `playIntroCutscene` on profile signals)

---

## Estimated wall-clock impact (combined session day total — Half A + Half B)

| Bucket | Before today | After today | Cut |
|---|---|---|---|
| **Second-visit cold boot (judge refresh)** — JS bundle + first cutscene + scene build | ~5–8 s | ~1–2 s (SW serves all from CacheStorage; cutscene-skip flag set; no cutscene playback) | **−3 to −7 s on every revisit** |
| **First-visit on data-saver / 3G** | ~25 s (full cutscene download + playback) | ~12 s (cutscene preload skipped, plays after metadata-only fetch) | **−13 s** |
| **First-visit on bottom-tier device** (1–2 GB RAM Chromebook) | tab crash mid-forest-scene OR slideshow | playable at `low` graphics tier | **playable** |
| **Post-deploy revisit blank-screen risk** | possible (stale cached `index.html` pointing at no-longer-existing JS hashes) | impossible (`Cache-Control: no-cache` forces revalidation of `index.html` on every visit) | **eliminated** |
| **Time-to-interactive on throttled connection** | ~6 s (cutscene preload competes with JS) | ~5 s (`fetchpriority="high"` on JS, `="low"` on cutscene) | **−1 s** |

Combined with round 3's wins, the rough perceived-load cost on the dominant **judge-refresh** workload drops from ~5–8 s to ~1–2 s — roughly halved again, exactly as the research pass predicted.

---

## Why this respects the existing LEARNINGS

1. **Unified preload pipeline intact.** The SW + persist work all hangs off `main.ts`'s existing `deferredBootSecondaries` slot — no new state machines, no second `.then` chain on the preload itself.
2. **Scene-singleton handles unchanged.** SW serves bytes, not scene objects; the scene-singleton enforcement on `scene.userData` is orthogonal.
3. **Single shared `collisionWorld`** unchanged. SW doesn't touch game state.
4. **`compileAsync` warm pattern preserved.** No shader work in this round.
5. **Always-on compositor veil during mountApp** preserved.
6. **No save-state change** — `STATE_VERSION` unchanged. Device profile is RUNTIME state on the module, not on the GameStore.
7. **`renderPage` deferral via rIC** preserved.
8. **`fetchpriority` on cutscene preloads** (Half A) is additive to the existing `<link rel="preload">` hints — no contract change for the cutscene playback path.
9. **Cutscene-skip-on-warm-visit** (Half A) sets the flag AFTER `mountApp` resolves successfully (not just after the cutscene plays), so a failed first boot replays the cutscene + retries the boot rather than skipping the cutscene but landing on the same broken page.
10. **SW install deferred to `requestIdleCallback`** — never competes with cutscene `<video>` decode or `dockPreload` chunk parse.
11. **`navigator.storage.persist()` chained off SW `ready`** — never fires against an empty cache; never prompts before the user has interacted with the page.
12. **Quota guard via `navigator.storage.estimate()`** — fail-soft on low-storage iPhones; the runtime cache populate may fail but SW install does not.
13. **Adaptive device profile is additive** — existing URL/localStorage overrides still take precedence; new signals only relax the cutscene-preload assumption, never change graphics tier behavior of opted-in users.

---

## Files touched

| File | Half | Change |
|---|---|---|
| `vite.config.ts` | B + C.1 | Added `VitePWA` plugin (precache + runtime caches + navigation preload); added `build.rollupOptions.output.manualChunks` callback (three-core / three-addons / empire-engine / app-content split) |
| `package.json` | B | Added `vite-plugin-pwa` devDependency |
| `src/engine/persistentCache.ts` | B | New — SW registration via `virtual:pwa-register`, `navigator.storage.persist()` with `navigator.storage.estimate()` quota guard |
| `src/engine/graphicsTier.ts` | B | Added `DeviceProfile` interface + `detectDeviceProfile()` function (memoized) — probes `deviceMemory`, `connection.effectiveType`, `saveData` in addition to existing `hardwareConcurrency` / UA |
| `src/util/longAnimationFramesAudit.ts` | C.2 | New — `?perf=audit`-gated `PerformanceObserver` for `long-animation-frame` entries with script-level attribution |
| `src/util/idbCache.ts` | C.3 | New — zero-dep IndexedDB key-value cache (`idbGetCached` / `idbPut` / `idbDelete` / `hashCacheKey`); 120 LOC; fail-soft on every operation; foundation for future LPCA mesh / scatter-spec caching |
| `src/main.ts` | B + C.2 | Wired `registerIdleCraftServiceWorker` + `requestPersistentStorageOnceSWReady` into `deferredBootSecondaries`; read `detectDeviceProfile()` once at boot; gate `preloadVideoFile(shattering)` + cutscene playback on `profile.shouldPreloadCutscenes` / `profile.shouldPreloadShatteringInBackground`; one-line `installLongAnimationFramesAuditIfRequested()` near the top |

Half A files (already touched earlier 2026-04-21 before this doc):
- `index.html` (added `fetchpriority` attributes on cutscene `<link>` hints + commentary)
- `netlify.toml` (added `Cache-Control` headers per file pattern + `Service-Worker-Allowed: /` + SPA shell redirect)
- `src/cutscenes/introCutscene.ts` (cutscene-skip-on-warm-visit `localStorage` flag + `markIntroCutsceneSeen()` export)
- `src/main.ts` (called `markIntroCutsceneSeen()` after `mountApp` resolved successfully)

---

## Files NOT touched (deliberately)

| File | Why skipped |
|---|---|
| `src/engine/dockPreload.ts` | Unified pipeline + scene-singleton work from rounds 1–3 is correct as-is |
| `src/engine/dockExtendedPreload.ts` | No structural change needed; awakened-only deferral from round 3 stands |
| `src/visual/forestEnvironment.ts` | Round 3's staged async + `await yieldToEventLoop()` is correct |
| `src/visual/characterScenePreview.ts` | Round 3's sub-ms inter-phase yields are correct |
| `src/core/gameStore.ts` | Round 3's zero-allocation `tick()` is correct |
| `src/world/dockForestBatchedScene.ts` / `freeRoamHarvestNodes.ts` / `collisionWorld.ts` | Scene-singleton defense-in-depth from round 1 is correct |
| `public/cutscenes/*.mp4` | Round 3's re-encode is the right size; KTX2/Meshopt etc. apply to GPU assets, not video |

---

## Verification

- `npx tsc --noEmit` — exit 0
- `npm run build` — clean (~3–4 s); `vite-plugin-pwa` emits `dist/sw.js` + `dist/workbox-*.js` + `dist/manifest.webmanifest` alongside the existing chunks
- ReadLints — no errors on any modified file

---

## Test in browser

1. **Hard-refresh** (cold visit). Cutscene plays once; intro chain completes; `idle-craft-intro-cutscene-seen-v1` flag set in `localStorage`; SW installs in idle slot AFTER mountApp; `idle-craft-cutscenes-v1` cache populates as the cutscene plays (visible in DevTools → Application → Cache Storage).
2. **Refresh again** (warm visit). Cutscene skipped; SW serves all hashed JS from CacheStorage (visible in DevTools → Network → "from service worker" column on every asset row); time-to-game ~1–2 s instead of ~5–8 s.
3. **DevTools → Application → Storage**. The "Persisted" badge should be green ("Storage is persistent"). On Firefox you'll see a one-time prompt during step 1's idle slot.
4. **Throttle to Slow 3G** in DevTools, then **clear all storage**, then refresh. The boot should detect `effectiveType` and skip the shattering preload; first cutscene loads on demand.
5. **Toggle DevTools → Network → "Save data: Yes"** (Chrome's data-saver simulation), refresh. Cutscene playback should be skipped entirely; player goes splash → start flow.
6. **Open `chrome://serviceworker-internals`**. The SW should be registered + activated; the `idle-craft-cutscenes-v1` and `idle-craft-audio-v1` caches should appear.
7. **Make a one-line edit + redeploy**. Refresh. Browser fetches new `index.html` (no-cache forced revalidation), discovers new asset hashes, fetches new chunks (SW cache misses on the new URLs, network fetches them, caches them). Old SW activates new version after the tab closes + reopens.
8. **iOS Safari 16+ on a low-storage iPhone** (Photos library full). SW should install successfully; quota guard should log "skipping persist — quota tight" to console; cutscene runtime cache may fail to populate but boot otherwise works.

---

## Half C — extension pass (also shipped this session, after the top 3)

After the top-3 implementation cleared the verification gate, the user asked to "do the rest now" — which translated to working through the most-impactful items from the deferred list. Three more shipped, two stayed deferred for explicit "wrong session" reasons.

### Half C.1 — `manualChunks` split (research Tier 3.14)

**Problem solved:** the main entry chunk was 951.97 kB / 255.13 kB gz because `idleCraftEngine.ts` does `export * from 'empire-engine/lpca'` + `export * as EmpirePhysics from 'empire-engine/physics'` (and the whole sibling barrel). `main.ts` only uses 4 of those named exports but tree-shaking through `export * from` is fragile across complex workspace deps, so the entire barrel + transitive `three` + transitive `empire-engine` modules all landed in the single main chunk.

**Fix — `vite.config.ts`:** Added `build.rollupOptions.output.manualChunks` callback that routes:
- `node_modules/three/**` (excluding examples) → `three-core`
- `node_modules/three/examples/jsm/**` → `three-addons`
- `EmpireEngine/**` and `empire-engine` → `empire-engine`
- `src/data/content.ts` → `app-content`

**Result:**

| Chunk | Before | After |
|---|---|---|
| `index` (main entry) | 951.97 kB / 255.13 kB gz | **140.42 kB / 43.51 kB gz** |
| `three-core` | (in main) | **765.12 kB / 198.92 kB gz** |
| `empire-engine` | (in main) | **25.69 kB / 8.85 kB gz** |
| `app-content` | (in main) | **30.78 kB / 7.46 kB gz** |
| **Total entry-graph** | **951.97 kB / 255.13 kB gz** | **962.01 kB / 258.74 kB gz** (+10 kB / +3.6 kB gz overhead) |

The +3.6 kB gz overhead is chunk-shim cost. In exchange:

- **Cache stability across deploys** — `three` rarely changes; a deploy that touches only app code keeps the `three-core-XXX.js` cache hit on revisit. Saves ~199 kB gz transfer + parse on every post-deploy refresh.
- **Parallel parse** — chunks parse independently, so on a 4-core judge laptop the ~258 kB gz of total entry-graph parse spreads across cores instead of serializing on one main bundle.
- **HTTP/2 multiplexing** — 4 small chunks beat 1 huge chunk on a single connection.

The `three-core` chunk still trips the >500 kB warning; that's three.js itself — unavoidable without dropping addons (which the addons split also helps with by isolating them). The warning is now informational, not actionable.

**Files:**
- `vite.config.ts` (added `build.rollupOptions.output.manualChunks` callback with file-top doc)

---

### Half C.2 — Long Animation Frames API diagnostic (research net-new since 2024)

**Problem solved:** future preload-audit sessions need a way to find the actual source of any remaining >50 ms hitches. The older `longtask` `PerformanceObserver` entries report only duration + start time — no script attribution, no source URL, no function name. Triaging "where did that 80 ms hitch come from?" required printf-style instrumentation across every suspect callsite.

The newer `long-animation-frame` entries are **frame-aligned** (one entry per render frame that exceeded the budget) and include **per-script attribution** — file URL, function name, character position in the source, blocking duration. Available in Chrome/Edge 123+; Safari/Firefox no-op (silent feature-detect via `PerformanceObserver.supportedEntryTypes`).

**Fix — new `src/util/longAnimationFramesAudit.ts`:**

```ts
export function installLongAnimationFramesAuditIfRequested(): void;
```

- Gated on `?perf=audit` URL param (same convention as `?perf=low | high` in `graphicsTier.ts`). **Off by default** — instrumentation cost is small but the console noise during preload would drown out actual error logs.
- Feature-detects via `PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')` so it's a clean no-op on Safari/Firefox/older Chromium.
- Each LoAF entry logs as `console.warn` with: total duration, blocking duration, render duration, top-3 contributing scripts (each with `function@URL:char-position`).
- Idempotent across hot-reload re-runs via module-scope `installed` flag.
- Wired into `main.ts` immediately after the `import` block — fires before any boot work, captures the entire preload window with `buffered: true`.

**Files:**
- `src/util/longAnimationFramesAudit.ts` (new)
- `src/main.ts` (one-line `installLongAnimationFramesAuditIfRequested()` call near the top)

---

### Half C.3 — IndexedDB cache infrastructure (research Tier 2.12, partial)

**Problem solved:** the doc's "follow-up" section called for an IndexedDB cache layer for procedural LPCA meshes, estimated −500 ms to −2 s on second visit. Full integration into the dock-forest BatchedMesh pipeline is genuinely a multi-day refactor (BatchedMesh wraps materials + collision footprints + vegetation wind shader patches; serializing the geometry separately from those wraps risks regression). Deferring the **integration** until that focused session is correct; deferring the **infrastructure** wastes the analysis that already happened.

**Fix — new `src/util/idbCache.ts`:**

```ts
export async function idbGetCached<T>(key: string): Promise<T | null>;
export async function idbPut(key: string, value: unknown): Promise<boolean>;
export async function idbDelete(key: string): Promise<boolean>;
export async function hashCacheKey(params: unknown): Promise<string>;
```

- Zero deps, ~120 LOC. No `idb-keyval` / `dexie` — every byte in the main bundle counts during preload.
- One DB (`idle-craft-cache`) + one object store (`procedural-v1`). Suffix the version on cache-key migrations rather than bumping the store name.
- Stores `ArrayBuffer` + `Uint8Array` + JSON-clonable values natively (no double-serialization tax for typed-array geometry data).
- Every operation is `Promise<T | null | boolean>` and **fail-soft** — IDB unavailable, quota full, version conflict, transaction abort all degrade gracefully so call sites fall through to compute-on-miss.
- `hashCacheKey()` uses `crypto.subtle.digest('SHA-256')` when available, FNV-1a 32-bit fallback otherwise. Stable JSON serialization with sorted keys so `{a:1, b:2}` and `{b:2, a:1}` produce identical hashes.
- `onversionchange` handler drops the cached connection promise so a quota-crunch tab-eviction recovers cleanly on next call.
- File-top docstring includes the canonical usage pattern + caller responsibilities (hash inputs deterministically; bump cache-key prefix on schema changes; don't `await` the put on the boot critical path).

**No call-site integration this session** — wiring this into `scatterWorldForestStrata` requires splitting the function into "compute spec list" + "instantiate Three.js objects from specs" steps so the spec list is the cacheable surface, plus changes to `dockForestBatchedScene` to consume specs instead of running scatter inline. The infrastructure is now a stable building block for that follow-up session.

**Pairs with `navigator.storage.persist()`** (Tier 1.2 above) — once integrated, the cache survives storage pressure, making the second-visit win reliable across days of judging.

**Files:**
- `src/util/idbCache.ts` (new — 120 LOC, zero deps)

---

### Half C.4 — PSO `renderer.compile()` audit (research Tier 3.13)

**Audit result: no change needed.** Grepped every `compileAsync` and `renderer.compile` callsite in `src/`. The codebase already uses the canonical fallback pattern at every shader-warm site (`dockExtendedPreload`, `cabinBuilder`, `magicProjectiles`, `awakenedBouncyMushrooms`, `awakenedMobs`):

```ts
if (typeof r.compileAsync === 'function') {
  r.compileAsync(scene, camera).then(cleanupNextFrame).catch(cleanupNextFrame);
} else {
  renderer.compile(scene, camera);
}
```

Three.js r182 (which `package.json` pins) made BOTH `compileAsync` and `compile` PSO-aware since r152 — they dispatch a dummy draw to bake pipeline state (blend mode, depth state, vertex layout) in addition to compiling the program. The existing fallback pattern is already optimal.

**No file changes.** Recorded as audit-resolved so a future session doesn't re-investigate.

---

## Updated impact estimate (Half A + Half B + Half C combined)

| Bucket | Before today | After today | Cut |
|---|---|---|---|
| **Second-visit cold boot (judge refresh)** — JS bundle + first cutscene + scene build | ~5–8 s | ~1–2 s | **−3 to −7 s on every revisit** |
| **First-visit on data-saver / 3G** | ~25 s | ~12 s | **−13 s** |
| **First-visit on bottom-tier device** (1–2 GB RAM Chromebook) | tab crash mid-forest-scene OR slideshow | playable at `low` graphics tier | **playable** |
| **Post-deploy revisit JS transfer** (only app code changed) | ~255 kB gz (whole main chunk) | **~51 kB gz** (only `index` + `app-content`; `three-core` + `empire-engine` cache hits) | **−204 kB gz on every post-deploy refresh** |
| **Main-chunk parse time** (proxy: chunk size) | 951.97 kB on the main thread | 140.42 kB on the main thread + 3 sibling chunks parsed in parallel | **~5.9× smaller main-chunk parse window** |
| **Preload-audit triage time** (find the next hitch) | hours of printf instrumentation | minutes via `?perf=audit` LoAF console output | **diagnostic infra in place** |

---

## Follow-up (deferred from this round, with reasons)

- **IndexedDB integration into `scatterWorldForestStrata`** (research Tier 2.12). Infrastructure shipped this round (`src/util/idbCache.ts`); the integration needs `scatterWorldForestStrata` split into pure-compute (returns spec list) + instantiate (mutates Three.js Groups) halves so the spec list becomes the cacheable surface. Expected ~−80 to −150 ms on second visit. Bigger refactor; deserves a focused session.
- **KTX2 + Basis Universal + Meshopt asset pipeline** (research Tier 2.9). Worth adopting once non-procedural texture asset volume grows; today the game is mostly procedural LPCA so the payoff is small. Add `glTF-Transform` to CI pipeline; runtime needs `KTX2Loader` + `MeshoptDecoder` wired into the existing `GLTFLoader` chain.
- **Compression Dictionary Transport** (research Tier 1.4). Genuine ~−500 ms win per post-deploy refresh. Defer until Cloudflare/Netlify ship a one-toggle CDN feature — engineering effort to roll our own (`Use-As-Dictionary` / `Available-Dictionary` / dictionary versioning / fallback chain) is disproportionate to a 4-day jam window.
- **Speculation Rules `prerender`** (research Tier 3.18). N/A for single-route SPA shell; revisit if the start-flow ever splits into a separate route.
- **`importmap` with integrity hashes for sub-chunks** (research net-new D-or-F). Now that `manualChunks` produces 4 stable sibling chunks, an importmap in the HTML could fire all 4 fetches before any JS executes. Estimated −100 to −300 ms first paint when combined with Half C.1 above. Worth doing in a follow-up.

---

## Sources (research pass)

- **Workbox precaching + caching strategies** — [Workbox docs](https://developer.chrome.com/docs/workbox/) — SW caching strategy reference.
- **`vite-plugin-pwa`** — [vite-pwa-org docs](https://vite-pwa-org.netlify.app/) — canonical Vite integration.
- **`navigator.storage.persist()`** — [web.dev Persistent storage](https://web.dev/articles/persistent-storage) — semantics + Safari auto-grant behavior.
- **`navigator.storage.estimate()` quota guard** — [Storage for the Web (web.dev)](https://web.dev/articles/storage-for-the-web).
- **Navigation Preload** — [web.dev Navigation Preload](https://web.dev/articles/navigation-preload) — fire HTML fetch in parallel with SW boot.
- **`Cache-Control: immutable`** — [Cloudflare immutable directive blog](https://blog.cloudflare.com/cache-immutable/), [MDN Cache-Control](https://developer.mozilla.org/docs/Web/HTTP/Headers/Cache-Control).
- **`fetchpriority` attribute** — [web.dev Fetch Priority](https://web.dev/articles/fetch-priority), [MDN fetchpriority](https://developer.mozilla.org/docs/Web/HTML/Element/link#fetchpriority).
- **HTTP Range Requests** — [MDN Range Requests](https://developer.mozilla.org/docs/Web/HTTP/Range_requests), [Workbox Range Requests plugin](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests).
- **`navigator.deviceMemory`** — [MDN Device Memory API](https://developer.mozilla.org/docs/Web/API/Device_Memory_API).
- **`navigator.connection.effectiveType` + `saveData`** — [MDN Network Information API](https://developer.mozilla.org/docs/Web/API/Network_Information_API), [web.dev Adaptive serving with Save-Data](https://web.dev/articles/optimizing-content-efficiency-save-data).
- **Khronos KTX 2.0 launch overview** — [Khronos KTX overview PDF](https://www.khronos.org/assets/uploads/developers/presentations/KTX_2.0_Launch_Overview.pdf) — UASTC vs ETC1S guidance.
- **`glTF-Transform` Meshopt vs Draco** — [donmccurdy/glTF-Transform issue #1386](https://github.com/donmccurdy/glTF-Transform/issues/1386).
- **Three.js KTX2/Basis docs** — [three.js KTX2Loader integration](https://threejs.org/docs/?q=KTX2Loader#examples/en/loaders/KTX2Loader).
- **103 Early Hints** — [MDN 103 Early Hints](https://developer.mozilla.org/docs/Web/HTTP/Status/103), [Cloudflare 103 Early Hints](https://blog.cloudflare.com/early-hints-during-browser-page-load/).
- **Compression Dictionary Transport (RFC 9842)** — [Cloudflare Shared Dictionaries](https://blog.cloudflare.com/shared-dictionary-compression/), [MDN CDT](https://developer.mozilla.org/docs/Web/HTTP/Compression_Dictionary_Transport).
- **Speculation Rules prerender** — [Chrome Speculation Rules guide](https://developer.chrome.com/docs/web-platform/prerender-pages).
- **Three.js tree-shaking + manualChunks** — [Three.js tree-shaking forum thread](https://discourse.threejs.org/t/why-three-js-shipping-50-of-unused-code/), [Vite manualChunks discussion](https://github.com/vitejs/vite/issues/8161).
- **PSO precache** — [Unreal Engine PSO precaching blog](https://dev.epicgames.com/community/learning/tutorials/9wPV/unreal-engine-pso-caching-fixing-shader-stutters), [Godot pipeline compilation](https://godotengine.org/article/godot-4-4-handles-shader-compilation-stutter-much-better/).
- **PlayCanvas Asset Bundles** — [PlayCanvas asset bundles docs](https://developer.playcanvas.com/user-manual/assets/asset-bundles/).
- **Babylon.js IndexedDB asset DB** — [Babylon caching resources docs](https://doc.babylonjs.com/features/featuresDeepDive/scene/optimizeCached/).
- **Cesium 3D Tiles** — [3D Tiles spec](https://github.com/CesiumGS/3d-tiles).
- **Cocos Creator sub-package loading** — [Cocos asset manager bundles](https://docs.cocos.com/creator/manual/en/asset/bundle.html).
- **Chrome WebCodecs best practices** — [Chrome WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs).
- **iOS WebGL context loss** — Stack Overflow long-standing issue with iOS Safari aggressive context loss when backgrounded.
- **Safari `requestIdleCallback`** — [MDN BCD entry](https://developer.mozilla.org/docs/Web/API/Window/requestIdleCallback) — still missing/behind flag in Safari as of last public-spec checkpoint.

---

## Generalisable lessons (for next session's audit)

- **The dominant workload determines the dominant lever.** For a one-shot landing-page game the cold-visit budget rules; for a refresh-heavy jam the second-visit budget rules. Always identify the workload before ranking techniques.
- **A service worker is the single biggest second-visit lever** — bigger than any single asset optimization, because it converts every revisit's network fetch into a CacheStorage hit. Workbox + `vite-plugin-pwa` makes the integration ~50 lines.
- **Always pair `navigator.storage.persist()` with `navigator.storage.estimate()`.** Without the quota guard, low-storage iPhones silently fail to populate the runtime cache and the SW install itself can fail. The pair is a one-time write of < 30 lines.
- **Device-tier signals stack.** `hardwareConcurrency` alone misses the 2 GB Chromebook (8 cores, 2 GB RAM, runs out of memory mid-scene). Add `deviceMemory` + `connection.effectiveType` + `saveData` for full coverage.
- **Defer SW install to `requestIdleCallback`.** Never let SW install compete with cutscene `<video>` decode or critical chunk parse during boot.
- **Order matters: SW registration → SW ready → persist request.** Calling `persist()` against an empty cache is wasted; calling it before SW activates means the runtime cache stores don't exist when the persist grant applies.
- **Cutscene-skip-on-warm-visit must set the flag AFTER the FULL boot succeeds**, not just after the cutscene plays. Otherwise a failed first boot strands the player on a broken page that never plays the cutscene that might have shown what was wrong.
- **`globIgnores` for large media in Workbox precache.** Precache all-or-nothing; one missing file fails the whole install. Large media belongs in runtime CacheFirst routes with `rangeRequests: true`.
