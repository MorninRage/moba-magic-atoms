/**
 * MOBA — Magic Orbiting Brandished Atoms (fork of IDLE-CRAFT runtime).
 * Sticky dock: procedural LPCA-style character (PBR), equipment attachments, gather + page actions.
 *
 * **Boot strategy (Vibe Jam "instant entry"):**
 *   1. Title paints from a small static graph (start flow + audio + room hub + system menu).
 *   2. Heavy modules — `./ui/mountApp`, `./engine/dockPreload` → `CharacterScenePreview` — are
 *      **dynamic-imported** so they parse _after_ first paint.
 *   3. Once the title is up, we kick off {@link startIdleCraftDockPreload} to build the WebGL
 *      scene in an offscreen container while the player reads the title / picks a preset.
 *   4. On `Enter world`, `mountApp` consumes the preloaded preview → reparent canvas → game
 *      appears nearly instantly instead of waiting on the scene build.
 */
import { GameStore, hasIdleCraftSave } from './core/gameStore';
import { detachStartFlowRoomHub, mountStartFlow } from './ui/mountStartFlow';
import {
  applyVibeJamPortalArrivalClass,
  buildVibeJamPortalExitUrl,
} from './vibeJamPortal';
import {
  registerCharacterCameraForSystemMenu,
  bindRealSystemMenu,
} from './ui/systemMenuStub';
import {
  bootstrapIdleCraftEngineRuntime,
  fetchEmpireProject,
  hydrateEmpireConfigFromProject,
  logIdleCraftWebGPUCompat,
} from './engine/idleCraftEngine';
import {
  registerIdleCraftServiceWorker,
  requestPersistentStorageOnceSWReady,
} from './engine/persistentCache';
import { dumpRound5Measures, installLongAnimationFramesAuditIfRequested, measureBlock } from './util/longAnimationFramesAudit';
import { schedulePostTask } from './util/mainThreadYield';
import { withViewTransition } from './util/viewTransitions';
import { probeWorkerCapabilities, verifyAtomicsRoundTrip } from './worker/capabilityGate';

/*
 * BOOT-BUNDLE TRIM (Vibe Jam 2026 instant-entry target).
 *
 * The following modules are dynamic-imported from their original positions in the
 * boot graph so they DON'T inflate the main entry chunk:
 *   - `./audio/gameAudio` (audio context + music transport + audioDock.css —
 *     heavy decode setup, only needed once user signals intent to play / interact)
 *   - `./ui/systemMenu` (~92 KB system-menu-bg.webp + graphics/lighting/audio
 *     panels — only needed when ESC is pressed)
 *   - `./ui/scrollbarGlowPulse` (purely cosmetic scrollbar effect)
 *   - `./net/roomHub` (WebSocket lobby client; only needed for online play
 *     and the title screen's lobby status line)
 *
 * **Static-leak guard:** `gameAudio` and `roomHub` are also imported by
 * `core/gameStore.ts`, `ui/mountStartFlow.ts`, and `ui/mountOnlineLobby.ts`
 * — modules that *are* in the static-from-main graph. To keep them out of
 * the boot chunk, those callers route through `audio/audioBridge.ts` and
 * `net/roomHubBridge.ts`, which expose the same call-site API behind a true
 * dynamic `import()`. **Do NOT add fresh static imports of `./audio/gameAudio`
 * or `./net/roomHub` from any module reachable through `core/gameStore.ts`,
 * `ui/mountStartFlow.ts`, or `ui/mountOnlineLobby.ts`** — that immediately
 * collapses the dynamic-chunk boundary and pulls both modules back into the
 * main bundle. Use the bridge files instead. (`mountApp` and `systemMenu`
 * may keep their direct imports because they themselves are dynamic chunks.)
 *
 * Result: `gameAudio` ships as its own 28.7 KB / 8.5 KB gzip chunk, `roomHub`
 * as its own 8.7 KB / 2.9 KB gzip chunk, and `audioDock.css` (3 KB) leaves
 * the main CSS bundle. Combined with the system-menu / scrollbar splits,
 * title-screen first paint avoids parsing both the audio engine and the
 * lobby socket client.
 */
type AudioModule = typeof import('./audio/gameAudio');
type RoomHubModule = typeof import('./net/roomHub');
let audioModulePromise: Promise<AudioModule> | null = null;
let roomHubModulePromise: Promise<RoomHubModule> | null = null;
const loadAudioModule = (): Promise<AudioModule> =>
  (audioModulePromise ??= import('./audio/gameAudio'));
const loadRoomHubModule = (): Promise<RoomHubModule> =>
  (roomHubModulePromise ??= import('./net/roomHub'));

const appRootEl = document.getElementById('app');
if (!appRootEl) {
  throw new Error('Missing #app');
}
const appRoot: HTMLElement = appRootEl;

/*
 * === 2026-04-20 chunk-prefetch on entry ===
 *
 * Kick the heaviest dynamic chunks the moment `main.ts` runs. The browser
 * fetches + parses them in parallel with everything else, so by the time
 * `enterGame` reaches its first `import('./ui/mountApp')` etc., the chunk
 * is already cached and the `import()` resolves instantly.
 *
 * Idempotent — Vite dedupes via the module registry, so the LATER
 * `import()` calls in `loadMountAppModule` / `loadDockPreloadModule`
 * return the same in-flight (or already-resolved) promise.
 *
 * The errored .catch is intentional: a network failure here just means
 * the actual `import()` will retry; we don't want this prefetch to
 * surface unhandled-rejection warnings if the user is offline.
 *
 * Why not `<link rel="modulepreload">` in the HTML? Vite hashes chunk
 * URLs at build time, and there's no way to know the dist URL inside
 * `index.html` — bare `/src/foo.ts` paths 404 in production. JS-driven
 * prefetch lets Vite resolve the import to the right hashed chunk URL.
 */
void import('./engine/dockPreload').catch(() => {});
void import('./engine/dockExtendedPreload').catch(() => {});
void import('./ui/mountApp').catch(() => {});
void import('./ui/expeditionLoadingOverlay').catch(() => {});

/*
 * === Always-on early preload kick (post-cutscene-removal) ===
 *
 * Pre-cutscene-removal this was gated behind `isWarmCacheRevisit()` because
 * the first visit's curse-cutscene window (~50 s of video playback) gave the
 * preload pipeline plenty of cover anyway, and an early kick would have
 * fought the cutscene's video decoder for main-thread time.
 *
 * With the cutscenes gone, the title screen mounts ~immediately after
 * `bootIntroExperience` runs. The dock preload now needs every millisecond
 * of head-start it can get to be ready by the time the player clicks
 * Begin/Continue/New (~1-2 s later on a fast click). The title flow is a
 * static DOM tree with no WebGL of its own, so kicking the preload at
 * module-load time competes with nothing meaningful.
 *
 * Idempotent — `startIdleCraftDockPreload` returns the same in-flight /
 * resolved promise on subsequent calls, so `schedulePreloadAfterPaint`
 * later in `bootIntroExperience` is a no-op against the already-running
 * preload. No risk of double-kicking.
 */
void import('./engine/dockPreload')
  .then((m) => m.startIdleCraftDockPreload())
  .catch(() => {
    /* preload failed — `bootIntroExperience` will re-attempt via
     * `schedulePreloadAfterPaint`; mountApp's inline-attach fallback
     * still picks up the slack if both attempts fail. */
  });

/* === 2026-04-21 Preload Round 4 — Long Animation Frames audit ===
 *
 * Opt-in via `?perf=audit`. Wires a `PerformanceObserver` for
 * `long-animation-frame` entries with script-level attribution. Off by
 * default (audit overhead never lands in production traffic) — enable from
 * a triage session and read DevTools Console for per-LoAF rows showing
 * which file / function / char position caused each >50ms hitch.
 *
 * See `src/util/longAnimationFramesAudit.ts`.
 */
installLongAnimationFramesAuditIfRequested();

applyVibeJamPortalArrivalClass();

/* === 2026-04-22 OffscreenCanvas worker capability gate (Phase 0) ===
 *
 * Probes browser support for the render-worker path and logs a summary line.
 * Phase 0 ships with the worker as a STUB — main thread continues to render
 * via `CharacterScenePreview` regardless of this gate's result. The gate
 * exists now so:
 *   - COOP/COEP headers (netlify.toml + vite.config.ts) can be smoke-tested
 *     end-to-end against `crossOriginIsolated === true` without waiting on
 *     the full scene migration.
 *   - Phase 3 (`characterSceneHost`) can flip a single switch from "log" to
 *     "block boot if not capable" without touching this module's call sites.
 *
 * Render worker (see `src/worker/capabilityGate.ts`):
 *   - Default: main-thread dock. `?worker=1` opts into OffscreenCanvas worker when capable.
 *   - `?worker=0` blocks the worker path. `idleCraft.worker` holds the probe for DevTools.
 */
probeWorkerCapabilities();
/* Round-trip Atomics on a 1-int SAB. Catches browsers where the constructor
 * exists + isolation is on but Atomics methods are buggy. Sub-ms cost. */
verifyAtomicsRoundTrip();

/* === 2026-04-21 Round 5 phase B — top-level sync audit ===
 *
 * Both `bootstrapIdleCraftEngineRuntime()` and `new GameStore()` run BEFORE
 * the first `await` in `bootIntroExperience`, i.e. before the boot-veil
 * hand-off below. They're bracketed for measurement (`?perf=audit` console
 * dump at boot completion via `dumpRound5Measures`).
 *
 * Why neither is deferred yet:
 *   - `bootstrapIdleCraftEngineRuntime` warms the empire-engine
 *     `ProceduralTextures` singleton, which is consumed lazily by LPCA
 *     materials during `attachForestBackdrop`. The cutscene-skipped path
 *     fires `schedulePreloadAfterPaint` in the SAME tick as
 *     `scheduleSecondaries`, so deferring the warm-up creates a race where
 *     LPCA materials can ask for a texture before the singleton populates.
 *   - `new GameStore()` is referenced synchronously by the
 *     `vibejam-portal-exit` window listener installed at the bottom of this
 *     file AND by `mountStartFlow`. Restructuring the lifetime is out of
 *     scope for round 5.
 *
 * Round 6 will revisit if Phase A measures show either block exceeding ~5 ms.
 */
measureBlock('main.bootstrapEngineRuntime', () => bootstrapIdleCraftEngineRuntime());
void logIdleCraftWebGPUCompat();
void (async () => {
  const project = await fetchEmpireProject();
  hydrateEmpireConfigFromProject(project);
})();

const store = measureBlock('main.newGameStore', () => new GameStore());

/* === 2026-04-22 pre-bind store -> dock preview ===
 *
 * Pre-applies the player's character preset + equipped weapon/pick/shield to
 * the offscreen dock preview during the title flow. By the time mountApp's
 * `enterGame` calls `applyCharacterPreset` + `syncEquipment`, the preview is
 * already in sync and both calls short-circuit via their idempotency guards.
 *
 * Single biggest item moved off the click → game critical path: `syncEquipment`
 * was a 10-100 ms LPCA mesh build (4× `disposeGroupContents` + 1-3× weapon-
 * mesh construction). It now happens during title-screen idle time, behind the
 * forging veil's CSS animation, where the player can't see it.
 *
 * See `engine/dockPreload.ts` `bindGameStoreToDockPreview` for lifecycle
 * details — the binding self-skips after consume + auto-rebinds on
 * `returnToTitle` re-preloads, so this is fire-and-forget at boot. */
void import('./engine/dockPreload').then((m) => m.bindGameStoreToDockPreview(store));

/*
 * Defer audio + UI sounds + scrollbar pulse + system menu install + room hub
 * init until AFTER first paint. The title screen renders first; the moment the
 * browser has a paint frame we kick off the secondary modules. If the player is
 * super fast (clicks Begin within < 16 ms of seeing the title), the module
 * loaders still queue up and resolve before the dock mounts — no functional
 * regression, just a smaller initial parse.
 *
 * `requestIdleCallback` is preferred (lets the browser pick the slot); fallback
 * to a 60 ms timeout for browsers without it. After 1500 ms we force-trigger
 * regardless so screen-reader / keyboard-only users who never produce any rIC-
 * eligible idle slot still get their full feature set.
 */
function deferredBootSecondaries(): void {
  void loadAudioModule().then((m) => {
    m.initGameAudio();
    m.installDelegatedUiSounds(document.body);
  });
  void import('./ui/scrollbarGlowPulse').then((m) => m.installScrollbarGlowPulse());
  void import('./ui/systemMenu').then((m) => {
    m.installSystemMenu({
      isInGame: () => appRoot.querySelector('#app-shell') != null,
      onReturnToTitle: () => {
        void returnToTitle();
      },
    });
    bindRealSystemMenu({
      register: m.registerCharacterCameraForSystemMenu,
      open: m.openCampSystemMenu,
    });
  });
  void loadRoomHubModule().then((m) => m.initRoomHubFromEnv());
  /* === 2026-04-21 Preload Round 4 — service worker + persistent storage ===
   *
   * Register the SW via Workbox / vite-plugin-pwa, then request persistent
   * storage. Both fire from the existing rIC slot so they NEVER compete with
   * cutscene `<video>` decode or `dockPreload` chunk parse during boot.
   *
   * Order matters: the persist request is chained off SW registration so
   * the grant applies to a CacheStorage that actually has the runtime cache
   * stores set up. Quota guard inside `requestPersistentStorageOnceSWReady`
   * fail-soft on low-storage iPhones.
   *
   * See `docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md`.
   */
  void registerIdleCraftServiceWorker().then(() => requestPersistentStorageOnceSWReady());
}
let secondariesScheduled = false;
function scheduleSecondaries(): void {
  if (secondariesScheduled) return;
  secondariesScheduled = true;
  /* Round 5 phase F1 — `background` priority via `scheduler.postTask` on
   * Chrome/Edge/FF; falls back to the existing `requestIdleCallback` path
   * on Safari (preserves the original 1500 ms timeout via the helper's
   * background-fallback branch). Audio init + scrollbar + system-menu +
   * room hub + SW registration are all genuinely background work. */
  schedulePostTask(deferredBootSecondaries, 'background');
}

/**
 * Cached dynamic-import promise for the heavy game-shell module. First call triggers the fetch;
 * subsequent calls (e.g. ESC → return to title → re-enter) reuse the same resolved module.
 */
type MountAppModule = typeof import('./ui/mountApp');
let mountAppModulePromise: Promise<MountAppModule> | null = null;
function loadMountAppModule(): Promise<MountAppModule> {
  if (!mountAppModulePromise) mountAppModulePromise = import('./ui/mountApp');
  return mountAppModulePromise;
}

type DockPreloadModule = typeof import('./engine/dockPreload');
let dockPreloadModulePromise: Promise<DockPreloadModule> | null = null;
function loadDockPreloadModule(): Promise<DockPreloadModule> {
  if (!dockPreloadModulePromise) dockPreloadModulePromise = import('./engine/dockPreload');
  return dockPreloadModulePromise;
}

/**
 * Start preloading the dock scene in an offscreen container.
 *
 * **Trigger policy:** the dock preload is **idempotent** — first call wins, later calls return
 * the same in-flight or resolved promise. We trigger from three points so the work has the
 * maximum possible wall-clock budget without any single trigger blocking critical UI:
 *
 *   - {@link schedulePreloadAfterPaint} — fires one rAF after splash dismiss (BEFORE the
 *     curse cutscene starts). Safe during cutscene playback because
 *     `CharacterScenePreview.create` now drains its build as 6 staged phases (forest →
 *     avatar → lighting → spawn/camera → post-processing → render-loop start) with
 *     `await yieldAnimationFrame()` between each, and the GPU warm pipeline is scheduled
 *     via `requestIdleCallback` per pass — no single step blocks the main thread for more
 *     than ~50-150ms, well within the slack the browser has between video decode frames.
 *   - {@link schedulePreloadAfterPaint} (again) — fires from `showStartFlow` so the
 *     no-cutscene path (and post-`returnToTitle`) also gets the early kick.
 *   - {@link schedulePreloadOnCommit} — fires when the player clicks Begin / Continue / New.
 *     Final safety net for the rare case a player skips faster than rIC fires.
 *   - {@link enterGame} — direct `await` on `consumeIdleCraftDockPreload` as the absolute
 *     guarantee that the dock is built before game UI mounts.
 *
 * Multiple triggers are safe because `startIdleCraftDockPreload` returns the cached promise
 * once started.
 */
function schedulePreloadOnCommit(): void {
  void loadDockPreloadModule().then((m) => {
    /* No progress callback — the title has its own visual and the preload is silent. */
    void m.startIdleCraftDockPreload();
  });
}

/**
 * Start the dock preload one paint after the current frame so it never steals time from the
 * frame that is about to render (title screen, cutscene first frame, etc.). Once kicked, the
 * preload's heavy work spreads across multiple frames via the staged-phase drain in
 * `CharacterScenePreview.create` + the rIC-scheduled GPU warm pipeline — see the static
 * factory's docstring for the per-phase policy.
 *
 * The `requestIdleCallback` guard with a short timeout lets the browser pick a slot that
 * doesn't compete with critical UI work, with a forced fallback so we don't wait forever on
 * slow pages or browsers without `rIC` (Safari).
 */
function schedulePreloadAfterPaint(): void {
  requestAnimationFrame(() => {
    const trigger = (): void => {
      /* Unified preload — single promise chain runs scene foundation +
       * gameplay layers (dock-forest BatchedMesh + collisionWorld + harvest
       * scatter + cabin + craftStation + projectiles + bouncy mushrooms +
       * defensive ward + mob shader warm) all into the offscreen preview
       * scene. When mountApp later consumes the preview, every handle comes
       * along for free → near-zero post-cutscene work. Fire-and-forget;
       * failures fall back to mountApp's inline ensure* attach path. */
      void loadDockPreloadModule().then((m) => {
        void m.startIdleCraftDockPreload().catch(() => {
          /* preload failed — mountApp's inline-attach fallback path
           * rebuilds everything fresh, so this is recoverable. */
        });
      });
    };
    /* Round 5 phase F1 — `user-visible`: dock preload IS what the player
     * is waiting to see, but it must not block the title-screen first
     * paint or input. `user-visible` is the right middle priority. */
    schedulePostTask(trigger, 'user-visible');
  });
}

async function returnToTitle(): Promise<void> {
  try {
    const m = await loadMountAppModule();
    m.disposeIdleCraftDockScene();
  } catch {
    /* Module not loaded yet = no game shell to dispose; nothing to do. */
  }
  registerCharacterCameraForSystemMenu(null);
  /* Audio module is deferred — only call into it if it's already loaded (typically
   * yes by this point since the user reached the game and exited). */
  if (audioModulePromise) {
    void audioModulePromise.then((m) => {
      m.setBattleMusicMode(false);
      m.setMusicMainMenuMode(true);
    });
  }
  if (roomHubModulePromise) {
    void roomHubModulePromise.then((m) => m.getRoomHub().leaveRoom());
  }
  store.clearOnlineSession();
  /* If a preload is sitting idle (never consumed this session), drop it — the next session's
   * preload will kick when the player clicks Begin/Continue on the returned title. */
  if (dockPreloadModulePromise) {
    void dockPreloadModulePromise.then((m) => m.disposeUnusedIdleCraftDockPreload());
  }
  /* === 2026-04-21 Round 5 phase E — View Transitions ===
   *
   * `disposeIdleCraftDockScene()` ran above so the canvas is already torn
   * down by the time the snapshot is captured. The cross-fade animates from
   * the disposed-canvas frame to the freshly-mounted title flow — perceived
   * latency win on a swap that's currently a hard cut. */
  withViewTransition(() => {
    appRoot.replaceChildren();
    mountStartFlow(appRoot, store, {
      hasSave: hasIdleCraftSave(),
      onEnterGame: enterGame,
      onCommitToPlay: schedulePreloadOnCommit,
    });
  });
}

function enterGame(): void {
  /* Boot order on game enter (post-cutscene-removal):
   *
   *   1. appRoot cleared via View Transition (await — see race-fix note below).
   *   2. Load mountApp + dockPreload + audio + loadingOverlay modules in
   *      parallel. mountApp is fetched but NOT awaited yet, so its parse
   *      cost overlaps with the preload-await below.
   *   3. IF the dock preload is still in flight (rare — player rushed past
   *      the title flow faster than the preload could finish): show the
   *      `expeditionLoadingOverlay` with live progress instead of a black
   *      screen. The preload was kicked at module top + again from
   *      `showStartFlow` so this path almost never triggers in practice.
   *   4. Mount the forging veil — covers mountApp's parse + dock-preview
   *      consume work with compositor-thread CSS animation so the page
   *      feels alive even when the JS main thread is busy.
   *   5. Await mountApp; consume the preloaded dock; the game shell appears.
   *   6. Double-rAF fade out the veil so it doesn't reveal a half-painted
   *      tutorial.
   */
  void (async () => {
    /* Round 5 phase E (race fix) — clear `appRoot` via View Transition and
     * AWAIT the swap before any loading-overlay mount touches `appRoot`.
     * Without the await, the overlay mount races the View Transition's
     * async update callback and the swap can wipe the overlay UI on the
     * first paint after click. */
    await withViewTransition(() => {
      detachStartFlowRoomHub();
      appRoot.replaceChildren();
    });
    /* Kick mountApp's chunk fetch in parallel with the preload await so its
     * parse cost (often 100-300ms on slower devices) overlaps with the
     * preload-finish wait instead of serializing in front of it. */
    const mountAppPromise = loadMountAppModule();
    const preloadModulePromise = loadDockPreloadModule();
    const audioPromise = loadAudioModule();
    const [preloadModule, audioModule, loadingOverlayModule] = await Promise.all([
      preloadModulePromise,
      audioPromise,
      import('./ui/expeditionLoadingOverlay'),
    ]);

    const preloadPromise = preloadModule.startIdleCraftDockPreload();
    const preloadProgress = preloadModule.getIdleCraftDockPreloadProgress();

    /* === 2026-04-22 single continuous veil ===
     *
     * Mount ONE veil that lives through both phases (preload-wait → mountApp
     * parse + consume) instead of mount/unmount/remount. The previous
     * two-veil sequence created a visible flicker that read as "another
     * preload starting" because the second veil reset progress to 0.05
     * and changed its label.
     *
     * Pre-cutscene-removal the swap was masked by the shattering cutscene
     * playing between the two veils (mounted via the cutscene's
     * `onCleanupStart` during its fade-out). With no cutscene cover, the
     * swap was exposed.
     *
     * The veil's CSS animations (transform + opacity only) run on the
     * compositor thread per Chromium's "Anatomy of Jank" research, so the
     * page feels alive even when the JS main thread is 100% saturated by
     * mountApp.
     *
     * Skip the veil entirely (no flash) when preload is already ready by
     * click time — common path on a slow clicker. Mount it lazily ONCE
     * we know mountApp has work to cover. */
    const veil = loadingOverlayModule.mountExpeditionLoading(appRoot);
    veil.setProgress(
      preloadProgress.fraction,
      preloadProgress.phase || 'Preparing your expedition…',
    );
    const preloadProgressUnsub = preloadModule.subscribeIdleCraftDockPreloadProgress((p) => {
      const label =
        p.fraction >= 1 - 1e-6
          ? 'Expedition ready…'
          : (p.phase || 'Preparing your expedition…');
      veil.setProgress(p.fraction, label);
    });
    await preloadPromise;
    preloadProgressUnsub();

    audioModule.setMusicMainMenuMode(false);

    /* Same veil now transitions to "finalizing" for the mountApp parse +
     * consume window. mountApp's `onLoadProgress` overrides the label as it
     * walks through its own phases. */
    veil.setProgress(0.05, 'Finalizing camp interface…');

    const { mountApp } = await mountAppPromise;
    try {
      await mountApp(appRoot, store, {
        consumePreloadedDock: (target) => preloadModule.consumeIdleCraftDockPreload(target),
        onLoadProgress: (fraction, status) => {
          veil.setProgress(fraction, status);
        },
      });
    } finally {
      veil.setProgress(1, 'Ready');
      /* Double-rAF: lay out, paint, THEN fade. Stops the veil from fading
       * to reveal a half-painted tutorial. */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          veil.remove();
        });
      });
    }
  })();
}

function showStartFlow(): void {
  mountStartFlow(appRoot, store, {
    hasSave: hasIdleCraftSave(),
    onEnterGame: enterGame,
    onCommitToPlay: schedulePreloadOnCommit,
  });
  /* Title is on screen — kick the dock preload immediately so it has the full duration of
   * the player's title-flow interaction (read title, pick mode, pick character) to build,
   * not just the ~1s between the Begin click and game mount. Idempotent vs the earlier
   * cutscene-time trigger and the on-commit trigger. */
  schedulePreloadAfterPaint();
}

/**
 * Tear down the inline `#boot-veil` painted by `index.html` at first browser
 * frame. Called the moment the boot bundle is ready to take over the visual.
 *
 * The veil's CSS animation (transform + opacity only) ran on the compositor
 * thread to keep the page feeling alive while the boot bundle parsed; once
 * the bundle has actual content to paint, we hand off via the global the
 * inline `<script>` in `index.html` exposed.
 *
 * Idempotent + safe — `__hideBootVeil` self-removes after the 320 ms fade,
 * so calling twice is a no-op on the second call.
 */
function hideInlineBootVeil(): void {
  const w = window as Window & { __hideBootVeil?: () => void };
  try {
    w.__hideBootVeil?.();
  } catch {
    /* Defensive — never let veil teardown break boot. */
  }
}

/**
 * Boot flow (post-cutscene-removal):
 *
 *   Page load -> inline boot veil -> bootIntroExperience():
 *     scheduleSecondaries  (audio + scrollbar + system menu + room hub +
 *                           service worker, all on background priority)
 *     hideInlineBootVeil   (hand the page off to the start flow)
 *     schedulePreloadAfterPaint  (kick the dock preload one rAF after first
 *                                 paint; idempotent vs the always-on early
 *                                 kick at module top)
 *     showStartFlow              (mount the title -> name -> mode -> char picker)
 *
 * No splash, no cutscene. The first user gesture (Begin/Continue/New)
 * unlocks the AudioContext via the audio module's lazy-resume path inside
 * `enterGame`, so music starts the moment the player commits to playing.
 */
function bootIntroExperience(): void {
  scheduleSecondaries();
  hideInlineBootVeil();
  schedulePreloadAfterPaint();
  showStartFlow();
  /* Round 5 phase A — surface accumulated measures. No-op without ?perf=audit. */
  dumpRound5Measures();
}

bootIntroExperience();

/**
 * When the 3D portal_enter clip finishes, leave for the official jam hub — it routes to the next game.
 * @see https://vibej.am/2026 (Portals section)
 */
window.addEventListener('vibejam-portal-exit', () => {
  const s = store.getState();
  const hpPct = Math.max(
    1,
    Math.min(100, Math.round((s.playerHp / Math.max(1, s.playerMaxHp)) * 100)),
  );
  let displayName = 'Survivor';
  try {
    const raw = localStorage.getItem('moba-atoms-display-name')?.trim().slice(0, 24);
    if (raw) displayName = raw;
  } catch {
    /* ignore */
  }
  const url = buildVibeJamPortalExitUrl({
    ref: window.location.host,
    username: displayName,
    color: 'amber',
    hp: hpPct,
  });
  window.location.assign(url);
});
