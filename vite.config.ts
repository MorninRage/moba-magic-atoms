import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, mkdirSync, cpSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * empire-port-writer — writes the live dev-server port to .empire/dev-port.json so the
 * EmpireEditor viewport iframe can find this exact project's game (instead of guessing
 * port 3000, which may belong to a different project that was opened earlier).
 */
function empirePortWriter(): Plugin {
  const portFile = join(__dirname, '.empire', 'dev-port.json');
  const cleanup = () => { try { unlinkSync(portFile); } catch { /* file already gone */ } };
  return {
    name: 'empire-port-writer',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address ? address.port : null;
        if (port == null) return;
        try {
          mkdirSync(join(__dirname, '.empire'), { recursive: true });
          writeFileSync(portFile, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }, null, 2));
        } catch { /* swallow — editor falls back to port scan */ }
      });
      server.httpServer?.on('close', cleanup);
      process.once('exit', cleanup);
      process.once('SIGINT', () => { cleanup(); process.exit(0); });
      process.once('SIGTERM', () => { cleanup(); process.exit(0); });
    },
  };
}

export default defineConfig({
  root: '.',
  /* Electron `loadFile(dist/index.html)` uses the file: protocol — absolute `/assets/…`
   * URLs resolve to the drive root and 404. Relative base keeps chunks next to index.html. */
  base: './',
  build: {
    /*
     * === 2026-04-21 Preload Round 4 — manualChunks split ===
     *
     * Before this split the main entry chunk was 951.97 kB / 255.13 kB gz
     * because `idleCraftEngine.ts` does `export * from 'empire-engine/lpca'`
     * + `export * as EmpirePhysics from 'empire-engine/physics'` (and the
     * whole sibling barrel) — `main.ts` only uses 4 named exports but
     * tree-shaking through `export * from` is fragile across complex
     * workspace deps, so the whole barrel landed in the main chunk.
     *
     * Splitting `three` + `empire-engine` + the large content data file
     * into sibling chunks doesn't reduce TOTAL JS shipped, but on the
     * judge-refresh workload it pays back two ways:
     *  1. **Cache stability** — `three` rarely changes; a deploy that
     *     touches only app code keeps the `three-core-XXX.js` cache hit on
     *     revisit, saving ~100 kB transfer + parse on every post-deploy
     *     refresh.
     *  2. **Parallel parse** — chunks parse independently, so on a 4-core
     *     judge laptop the ~250 kB gz of total entry-graph parse spreads
     *     across cores instead of serializing on the main bundle.
     *
     * Manual targets the largest, most stable groups. App-shape code stays
     * in the default index chunk so we don't fragment too aggressively.
     *
     * See `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md`.
     */
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('node_modules/three/') || id.match(/node_modules[\\/]three[\\/]/)) {
              return 'three-core';
            }
            if (id.includes('node_modules/three/examples/jsm') || id.match(/node_modules[\\/]three[\\/]examples[\\/]jsm/)) {
              return 'three-addons';
            }
          }
          if (id.includes('/EmpireEngine/') || id.match(/[\\/]EmpireEngine[\\/]/) || id.includes('empire-engine')) {
            return 'empire-engine';
          }
          if (id.match(/[\\/]src[\\/]data[\\/]content\.ts$/)) {
            return 'app-content';
          }
          return undefined;
        },
      },
    },
  },
  resolve: {
    /**
     * Force a single canonical `three` instance across the whole bundle.
     *
     * Without this, the linked `empire-engine` workspace dep
     * (`file:../EmpireEngine`) brings its own `three` copy from
     * `../EmpireEngine/node_modules/three` (installed there as a devDependency
     * for typechecking — `peerDependency: ">=0.160.0"` is the contract).
     * Vite's resolver walks UP from each source file's location, so this
     * project's own files resolve `'three'` against
     * `idle-deck/node_modules/three` while EmpireEngine's files resolve
     * against the sibling's `node_modules/three`. Two separate ES module
     * instances → the `THREE.WARNING: Multiple instances of Three.js being
     * imported.` runtime warning, and (more importantly) `obj.isMesh` /
     * `instanceof THREE.Mesh` checks across the bundle boundary silently
     * misfire because each copy has its own constructor identity.
     *
     * `dedupe: ['three']` collapses both resolution paths to the project's
     * own `node_modules/three` so every import reaches the same instance.
     * Same trick is documented for React in monorepos with linked workspaces.
     *
     * Add `'@types/three'` only if the warning ever returns from a deeper
     * dep tree (it doesn't ship its own runtime so it doesn't trigger the
     * warning today; dedupe is the runtime-side fix).
     */
    dedupe: ['three'],
    alias: {
      '@editor': resolve(__dirname, '../EmpireEditor/src'),
    },
  },
  server: {
    port: 3000,
    strictPort: false,
    /*
     * === 2026-04-22 OffscreenCanvas worker — COOP/COEP for SharedArrayBuffer ===
     *
     * Mirrors `netlify.toml` headers so `crossOriginIsolated === true` and
     * `SharedArrayBuffer` is available during local dev. Without these the
     * `src/worker/*` capability gate refuses to spawn the worker and the
     * dev session falls into the (still-shipping) main-thread fallback.
     *
     * `credentialless` (not `require-corp`) so cross-origin no-credentials
     * resources (Google Fonts, vibejam widget) load without each origin
     * needing to send `Cross-Origin-Resource-Policy: cross-origin`.
     */
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  /*
   * Vite worker bundling — keeps `src/worker/renderWorker.ts` in its own
   * chunk so it doesn't bloat the main entry. `format: 'es'` matches the
   * `{ type: 'module' }` option on `new Worker(url, ...)` in
   * `characterSceneHost.ts` (Phase 3).
   */
  worker: {
    format: 'es',
  },
  plugins: [
    empirePortWriter(),
    {
      name: 'copy-game-data',
      closeBundle() {
        const out = join(process.cwd(), 'dist');
        const copy = (src: string, dest: string) => {
          if (existsSync(src)) {
            mkdirSync(join(out, dest), { recursive: true });
            cpSync(src, join(out, dest), { recursive: true });
          }
        };
        if (existsSync('project.json')) copyFileSync('project.json', join(out, 'project.json'));
        copy('scenes', 'scenes');
        copy('recipes', 'recipes');
        copy('data', 'data');
        copy('assets', 'assets');
      },
    },
    /*
     * === 2026-04-21 Preload Round 4 — service worker (Workbox via vite-plugin-pwa) ===
     *
     * The Vibe Jam workload is judge-refresh-dominant: a single judge typically
     * loads the URL N times across 1-4 days while voting. The SW converts every
     * revisit's network fetch into a CacheStorage hit — by far the single
     * biggest second-visit lever (~10-20s saved on slow connections, ~3-7s on
     * broadband, every revisit). See `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md`.
     *
     * `injectRegister: false` — the SW is registered manually from
     * `src/engine/persistentCache.ts` (called from `main.ts` via the existing
     * `requestIdleCallback` slot in `deferredBootSecondaries`), so SW install
     * lands AFTER first paint, never competing with critical boot work.
     *
     * `globIgnores: ['audio/**']` — large media stays OUT of the precache
     * manifest. Workbox `precacheAndRoute` is all-or-nothing: one missing
     * file fails the whole install, and >50 MB lists choke. The music files
     * live in the runtime CacheFirst route below — they populate on first
     * play and survive across sessions.
     *
     * `navigationPreload: true` — Workbox emits `registration.navigationPreload
     * .enable()` so the HTML fetch fires in parallel with SW boot on every
     * navigation, hiding the 100-300ms SW-bootstrap stall on warm revisits.
     *
     * `rangeRequests: true` on audio — `<audio>` uses HTTP Range requests;
     * without the Range plugin Workbox's CacheFirst returns the full file
     * for every Range query which breaks playback on iOS Safari + Firefox.
     * With it, partial responses (status 206) are cached + replayed correctly.
     *
     * `registerType: 'autoUpdate'` + `Cache-Control: no-cache` on
     * `index.html` (in `netlify.toml`) means the next refresh after a deploy
     * always picks up new SW + new asset hashes; no judge ever sees stale code.
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [],
      manifest: {
        name: 'MOBA — Magic Orbiting Brandished Atoms',
        short_name: 'MOBA',
        description: 'Magic Orbiting Brandished Atoms — 3v3 MOBA (Vibe Jam 2026)',
        theme_color: '#080a0f',
        background_color: '#080a0f',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,webp,png,ico,json}'],
        globIgnores: [
          '**/audio/**',
          '**/node_modules/**',
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigationPreload: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/audio/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'moba-magic-atoms-audio-v1',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 },
              rangeRequests: true,
              cacheableResponse: { statuses: [0, 200, 206] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.origin === 'https://fonts.googleapis.com' ||
              url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'moba-magic-atoms-fonts-v1',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
