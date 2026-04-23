# Session 2026-04-21 — Preload Round 5 (prior-art digest: render-loop + main-thread budget)

## Context

Companion to:
- `docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md` — round 1 (unified pipeline + ghost mesh fix)
- `docs/SESSION_2026_04_20_PRELOAD_ROUND_2.md` — round 2 (sub-ms yields + deferred renderPage + tighter caps)
- `docs/SESSION_2026_04_20_PRELOAD_ROUND_3.md` — round 3 (cutscene re-encode + staged forest + zero-alloc tick + awakened-only deferral)
- `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md` — round 4 (Workbox SW + storage.persist + adaptive device profile)

Rounds 1–4 attacked **network + boot-cache** wins (preload pipeline, cutscene skip, service worker, immutable headers, adaptive device profile). Round 5 shifts the lens to **main-thread + render-loop budget** — the next bottleneck once the network is mostly free on judge-refresh.

This doc is **prior-art only** — no code shipped this session. The implementation plan lives in a follow-up planning doc.

The Vibe Jam workload is still judge-refresh-dominant (rounds 1–4 framing applies), but on warm-cache visits the dominant cost moves from "bytes over the wire" to "JS work between SW response and first interactive frame." That's where rounds 5+ have to land.

---

## Research scope

A parallel research pass evaluated the following 2025–2026 techniques against a 4-day jam window:

- `OffscreenCanvas` + Three.js in a worker
- `scheduler.yield()` as a lightweight `setTimeout(0)` / `requestIdleCallback` replacement
- `scheduler.postTask({ priority })` for tagged work scheduling
- WebGPU + Three.js `WebGPURenderer`
- View Transitions API (same-document)
- `BatchedMesh` vs `InstancedMesh` for foliage
- Frame-spread `InstancedMesh` / `BatchedMesh` upload via `requestIdleCallback` / `scheduler.yield`
- Three.js `RenderPipeline` / TSL / MRT (r183+)
- `DataTexture` for GPU-side instance state
- `WebGLQuery` for async readback
- Pre-allocated `TypedArray` pools for matrix updates
- `ImageBitmapLoader` vs `ImageLoader`
- Module workers (`new Worker(url, { type: 'module' })`)
- Concurrency-limited preload queue (Babylon / Unity LZ4 lesson)
- "Empty boot scene" pattern from Unity WebGL
- `Sec-CH-Prefers-Reduced-Motion` client hint
- Speculation Rules API

**Research value:** high — strong 2025–2026 prior art on every requested item; clear winners and clear "skip" calls for a 4-day jam window.

---

## Final ranking (impact ÷ difficulty)

Higher = ship sooner. All are **shippable inside the jam window** unless tagged research-only.

| # | Technique | Impact | Difficulty | Ratio |
|---|---|---|---|---|
| 1 | View Transitions API for scene flips | M (perceived) | S | High |
| 2 | `scheduler.yield()` + Safari fallback | M | S | High |
| 3 | `requestIdleCallback`: safety-buffer + timeout fallback | S–M | S | High |
| 4 | "Empty boot scene" audit of `main.ts` order | M–L | S | High |
| 5 | Concurrency-limited preload queue (Babylon / Unity pattern) | M | S | High |
| 6 | `ImageBitmapLoader` for textures | S–M | S | High |
| 7 | `scheduler.postTask` priority tags | S–M | S | High |
| 8 | Frame-spread `InstancedMesh` upload | L | M | High |
| 9 | `BatchedMesh` for multi-species foliage | L | M | High |
| 10 | Module workers (precondition for #11 / #R1) | enabler | S | Medium |
| 11 | `TypedArray` pooling | S | S | Medium |
| 12 | `WebGLQuery` for async readback | S–M | S–M | Medium |
| 13 | `Sec-CH-Prefers-Reduced-Motion` adaptive serving | S | S | Medium |

### Research-only — too risky for a 4-day jam window

| # | Technique | Why deferred |
|---|---|---|
| R1 | `OffscreenCanvas` + Three.js in a worker | XL refactor; DOM-coupled loaders + input plumbing must be re-routed via `postMessage` |
| R2 | WebGPU + Three.js `WebGPURenderer` migration | XL; r182 perf regressions, TSL rewrite, post-processing parity gaps |
| R3 | `RenderPipeline` / TSL / MRT (r183+) | WebGPU-tied, depends on R2 |
| R4 | Speculation Rules API | Negligible for single-route SPA shell |

---

## Detailed prior art

### Tier 1 — High ratio, ship this jam

**1. View Transitions API (same-document)** — wrap a scene swap in `document.startViewTransition(() => swap())` to get a free snapshot-then-animate transition between DOM states. Baseline newly available since Oct 14 2025 (Chrome, Edge, Safari, Firefox 144+). Perceived-only win — Chrome's own case-studies post is explicit that it masks latency rather than reducing it. Real win for cutscene→game and dream→awakened flips because users feel a 200 ms crossfade as faster than a 50 ms hard cut. Difficulty: S — one-line `?? swap()` fallback for browsers that don't support it.

**2. `scheduler.yield()` (Prioritized Task Scheduling API)** — awaitable yield-to-main-thread that resumes via a boosted priority queue, not a fresh task at the back of the line like `setTimeout(0)` or `requestIdleCallback`. Support 2026: Chrome/Edge 129+, Firefox 142+, no Safari. MDN flags it as "Limited availability." Available in workers too. For boot-time chunking it materially beats `requestIdleCallback`, which is severely throttled in background tabs (≥1000 ms delay measured in Jan 2026 deep-dive) and unreliable under load. Difficulty: S — `await scheduler.yield()` inside loops, with `setTimeout(0)` fallback for Safari.

**3. `requestIdleCallback` deadline + safety-buffer + timeout pattern** — refinement to existing `rIC` call sites: loop while `deadline.timeRemaining() > 2`, recursively re-schedule, pass `{ timeout: 2000 }` so critical boot work eventually runs even under load. We already use rIC; adopting the safety buffer + timeout fallback is the documented best practice. Direct precursor to migrating those call sites to `scheduler.yield()` (#2) where supported.

**4. "Empty boot scene" pattern from Unity WebGL** — ship an essentially-empty first scene whose only job is to render one frame and unblock the browser, then load real content asynchronously. Structural analogy: our intro splash IS the empty boot scene. Audit `main.ts` to confirm absolutely nothing heavy runs until after first paint, then chain into preloads via `scheduler.postTask({ priority: 'background' })`. Difficulty: S — audit pass first, then targeted reorder.

**5. Concurrency-limited preload queue (Babylon "load 2-3 models at a time" + Unity LZ4 lesson)** — two shipped-game patterns confirm the same insight: never let the boot path issue bulk-parallel asset requests; cap concurrency and prefer fast-decompress formats. Unity's documented win was switching WebGL builds from LZMA→LZ4 specifically because LZMA decode blocks the main thread. Difficulty: S — a 30-line concurrency-limited fetch queue. Ship if our preload currently fires N parallel fetches.

**6. `ImageBitmapLoader` instead of `ImageLoader`** — decodes images off-main-thread on every modern browser. Required if we go OffscreenCanvas (#R1) but useful even without it. Cumulative win for any UI sprite or texture not yet on a worker decode path. Difficulty: S, no downside.

**7. `scheduler.postTask({ priority })`** — tag work as `user-blocking` / `user-visible` / `background` so the browser orders it correctly under load. Support 2026: Chrome/Edge 94+, Firefox 142+, no Safari. Standalone: small-to-medium. Combined with #2 it lets us mark cutscene-warmup as `background` while shader compile is `user-blocking`, producing a measurable Chrome-side scheduling win (`requestIdleCallback` has no such concept). Pair with #2 behind one feature-detect wrapper.

**8. Frame-spread `InstancedMesh` / `BatchedMesh` upload** — pre-allocate the full buffer, write a slice per frame via `setMatrixAt` + targeted `instanceMatrix.needsUpdate = true`, drive with `requestAnimationFrame` or `scheduler.yield()`. The buffer-reallocation hitch is the actual jank source on shipped Three.js games. Direct fix for the first-scene-paint stutter symptom we already observe when uploading thousands of LPCA trees. Difficulty: M — the engine has no auto-spreader; we write the chunked uploader once and reuse. No API gating.

**9. Three.js `BatchedMesh` (r166+, hardened through r182)** — single draw call for multiple distinct geometries sharing one material. Different from `InstancedMesh`, which needs identical geometry. Large win for an LPCA-tree forest with 3–5 species — collapses N draw calls to 1 (1M-instance BVH demo proves the ceiling). Pre-allocate `maxInstanceCount` / `maxVertexCount` / `maxIndexCount`, never resize at runtime, set `perObjectFrustumCulled=false` and `sortObjects=false` for static foliage. r182 has a known WebGPU perf regression fixed in r183 — N/A for our WebGL2 path. Skip if we're already on a single `InstancedMesh` per species.

### Tier 2 — Medium ratio, ship if cheap

**10. Module workers (`new Worker(url, { type: 'module' })`)** — required precondition for any modern Vite worker pipeline. Baseline as of Jan 13 2026 — all four engines ship it, including Safari. Vite supports `new Worker(new URL('./w.ts', import.meta.url), { type: 'module' })` natively. By itself: zero impact; enables OffscreenCanvas / CPU-bake workers (#R1).

**11. Pre-allocated `TypedArray` pools for matrix updates** — avoid GC pauses during scene build by recycling `Matrix4` / `Float32Array` instances. Three.js itself follows this convention internally. Cheap insurance.

**12. `WebGLQuery` for async readback** — if we do GPU picking or any `readPixels`, wrap it in a `WebGLQuery` so the CPU doesn't stall for the GPU. Documented Three.js pattern. Difficulty: S–M. Ship if applicable (we should audit current picking code).

**13. `Sec-CH-Prefers-Reduced-Motion` client hint** — server-side adaptive serving (e.g., serve a still PNG instead of intro cutscene) without JS. Niche but free. Difficulty: S (Netlify header). Optional.

### Research-only — defer past the jam

**R1. `OffscreenCanvas` + Three.js in a worker** — move the entire Three.js render loop (and shader compile) off the main thread. Baseline 2026; Safari 17+ supports `OffscreenCanvas.getContext('webgl2')`. Potentially the single biggest win for boot-time main-thread saturation — shader compile, scene graph traversal, frustum culling, and matrix math all leave the main thread. **But:** any Three.js loader that touches DOM (CSS2DRenderer, certain texture loaders) breaks; we must use `ImageBitmapLoader` and synthesize input events via `postMessage`. XL refactor for an existing app — touches input plumbing, DOM-bound HUD, picking, and any third-party Three.js library that assumes `document`. Spike on a branch before committing.

**R2. WebGPU + Three.js `WebGPURenderer`** — production-ready since r171 (Sep 2025), all 4 engines ship WebGPU as of Nov 2025 (Safari 26+, Firefox 141+ Windows / 145+ macOS-ARM). Auto-fallback to WebGL2. Async pipeline creation eliminates WebGL's mid-frame shader compile jank — this is the structural advantage for boot. 2026 reality is mixed: multiple users report r182 WebGPU performance regressions vs r170 WebGL, fixed in r183. XL for an existing scene with custom GLSL — needs TSL conversion or shaderlib parity work; some post-processing nodes still missing parity. Excellent v2 bet; the `KHR_parallel_shader_compile` warm we already do is the right WebGL-side bridge until then.

**R3. `RenderPipeline` / TSL / MRT (Three.js r183+)** — node-based post-processing graph, single-pass MRT, no manual resize. WebGPU-only in practice. Large if we're WebGPU and post-process-heavy. Skip until R2 happens.

**R4. Speculation Rules API (`<script type="speculationrules">`)** — modern replacement for `<link rel="prerender">`; supports prefetch/prerender with eagerness knobs. Chromium-only in practice. Negligible for a single-route SPA shell (already confirmed in round 4). The only sub-feature potentially useful is `Speculation-Rules` HTTP header–driven subresource prefetch via Documents-rules, but the payoff overlaps existing `<link rel="preload">`. Skip.

---

## How this composes with rounds 1–4

| Round | Bottleneck targeted | This-round status |
|---|---|---|
| 1–3 | Preload pipeline / staging / yields | #3 (rIC refinement) and #2 (`scheduler.yield`) directly upgrade those existing call sites |
| 4 (Tier 1) | Network on judge refresh — Workbox SW + `storage.persist` + immutable headers | Now mostly free on warm SW visit — exposes #4 + #8 (CPU-side first-scene cost) as the next bottleneck |
| 4 (Tier 2) | First-visit perception — adaptive device profile + `fetchpriority` + `boot-veil` LCP | #1 (View Transitions) and #4 (empty boot scene) slot into the same "perception layer" without conflict |
| 4 (Tier 3) | PSO shader pre-warm via `renderer.compile()` | Compatible with #2 (yield between species' compile calls) |

No conflicts with shipped code. #1, #4, #8 are the highest-leverage additions this digest produces.

---

## Sources

- MDN — `Scheduler.yield()` — primary reference, browser-support matrix, priority semantics.
- Medium, Jan 2026 — Deep Dive: `scheduler.yield()` — quantitative comparison vs `requestIdleCallback` under load.
- caniuse — Scheduler API: `postTask` and `yield` — 2026 support matrix.
- web.dev, Oct 2025 — Same-document view transitions Baseline — Firefox 144 ship + Baseline status.
- Chrome blog — View Transitions case studies — explicit "perceived not actual" framing.
- web.dev — WebGPU now supported in major browsers — cross-browser WebGPU ship.
- webgpu.com news, Nov 2025 — WebGPU hits critical mass — Safari 26 / Firefox version matrix.
- utsubo, 2026 — What's new in Three.js 2026 — `WebGPURenderer` maturity, TSL, `RenderPipeline` (r183).
- Three.js discourse — r182 WebGPU regression — concrete "WebGPU isn't a free win in 2026" data point.
- caniuse — `OffscreenCanvas`; MDN compat issue 21127 — Safari 17 webgl2-in-worker support.
- Three.js — `BatchedMesh` docs and `InstancedMesh`-vs-`BatchedMesh` thread — when each applies.
- Three.js discourse — `BatchedMesh` + BVH 1M instances — large-scene ceiling.
- Israeli Tech Radar — Idle time chunking patterns — adaptive chunking + safety buffer.
- Unity discussions — empty boot scene pattern and LZMA→LZ4 lesson — shipped-game evidence.
- Babylon.js forum — concurrency-limited model loading — same insight from a different engine.
- web-platform-dx#143 — JavaScript modules in workers Baseline Jan 2026 — module worker support status.
- MDN — Speculation Rules API — current scope and Chromium-only reality.

---

## Next session

Implementation plan for the Tier 1 stack (#1, #2, #3, #4, #5, #6, #7, #8, #9), sequenced by ratio and dependency.
