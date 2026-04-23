/**
 * Cutscene overlay — plays a video file fullscreen, supports skip
 * (button / Esc / Space / Enter) after a brief grace period, and resolves
 * when the video ends or is skipped.
 *
 * Used by `bootIntroExperience` in `main.ts` to chain the intro cutscenes
 * (`intro_the_curse.mp4` then `intro_the_shattering.mp4`) before the start
 * flow appears.
 */
import './introCutscene.css';

export const INTRO_CUTSCENE_FLAG = 'idle-craft-intro-cutscene-seen-v1';
/**
 * Short grace window before "click anywhere on the picture" can skip — long
 * enough to ignore an accidental drag-release / double-click from the
 * Begin/Continue button that started the cutscene, but short enough that a
 * deliberate skip-tap feels instant.
 *
 * Was 1500 ms which made every skip tap during the first ~1.5s feel dead
 * — players hammered the picture and got nothing because clicks land on
 * the video element (which has `pointer-events: none`) and fall through
 * to root → trySkip → ignored. Skip BUTTON has no grace; keyboard skip
 * (Esc / Space / Enter) has no grace either. Only the click-anywhere path
 * needs a brief debounce.
 */
const SKIP_GRACE_MS = 350;

export const INTRO_VIDEOS = {
  curse: 'cutscenes/intro_the_curse.mp4',
  shattering: 'cutscenes/intro_the_shattering.mp4',
} as const;

/**
 * Plays on first visit; honored as "skip on warm visit" once the player has
 * watched OR skipped both intro cutscenes through to the post-shattering
 * mountApp boundary at least once.
 *
 * **Why this flag flipped 2026-04-21 (Preload Round 4):** Vibe Jam judging
 * involves repeated refreshes — every refresh today re-pays the curse video
 * download (12.36 MB) AND the shattering video (17.46 MB) AND ~50 s + ~76 s
 * of mandatory cutscene playback before the player can interact with the
 * scene they came back to evaluate. After this flip a returning visitor
 * goes straight from start-flow click → game shell, ~30 s faster on every
 * post-first-visit boot.
 *
 * The flag is set by `markIntroCutsceneSeen()`, called from `main.ts`
 * after the FULL intro chain (curse → start-flow → shattering → mountApp)
 * has completed at least once. Setting it earlier (e.g. just after the
 * curse cutscene) would cause the next refresh to skip the curse but
 * still play the shattering — a confusing partial-state UX.
 *
 * Players who explicitly clear localStorage (cookie reset, fresh
 * incognito) get the full first-visit experience again.
 */
export function shouldPlayIntroCutscene(): boolean {
  try {
    return localStorage.getItem(INTRO_CUTSCENE_FLAG) !== '1';
  } catch {
    /* private mode — no localStorage, fall back to "always play" so the
     * player at least gets the cutscene on every fresh session. */
    return true;
  }
}

export function markIntroCutsceneSeen(): void {
  try {
    localStorage.setItem(INTRO_CUTSCENE_FLAG, '1');
  } catch {
    /* private mode — fine, we'll just play it again next time */
  }
}

export function clearIntroCutsceneFlag(): void {
  try {
    localStorage.removeItem(INTRO_CUTSCENE_FLAG);
  } catch {
    /* ignore */
  }
}

type PlayCutsceneOptions = {
  videoSrc?: string;
  ariaLabel?: string;
  /**
   * Fired the instant the cutscene starts ending (skip click / Esc / video end /
   * load error). Synchronous callback, executed BEFORE the promise resolves
   * and BEFORE the fade-out completes — caller should use this to mount the
   * post-cutscene UI (loading veil, game shell) so the player sees the next
   * screen IMMEDIATELY instead of waiting through the fade.
   *
   * The cutscene `<div>` then fades out in the background and removes itself.
   * Since the loading veil's z-index is far above the cutscene's, the veil
   * paints on top right away — the cutscene fade is invisible.
   */
  onCleanupStart?: () => void;
};

/**
 * Maximum real-time we'll wait for the video to even reach `loadeddata`
 * before treating it as broken and resolving so the game shell boots
 * anyway. Without this, a network hang on the .mp4 would leave the
 * player on a black screen indefinitely.
 */
const VIDEO_LOAD_TIMEOUT_MS = 4500;

/**
 * Mounts the cutscene overlay onto `parent`, plays the video, and resolves when
 * the player skips OR the video ends. Always cleans up its own DOM and persists
 * the seen-flag on resolution.
 *
 * If the video element fails to load (offline, file missing, decode error), the
 * promise resolves immediately so the game shell can boot anyway.
 *
 * **2026-04-20 snappy-skip refactor:** the promise now resolves at the
 * START of cleanup (when skip is pressed / video ends), not at the end of
 * the fade-out. Callers should use `onCleanupStart` to begin mounting the
 * next screen the instant the cutscene starts to end, so the player sees
 * an immediate transition instead of staring at a fading video. The video
 * is also explicitly paused + src-cleared on cleanup so the decoder stops
 * eating CPU/GPU during the mountApp boot phase.
 */
export function playIntroCutscene(
  parent: HTMLElement,
  options: PlayCutsceneOptions = {},
): Promise<void> {
  const videoSrc = options.videoSrc ?? INTRO_VIDEOS.curse;
  const ariaLabel = options.ariaLabel ?? 'IDLE-CRAFT — intro cutscene';
  return new Promise<void>((resolve) => {
    const root = document.createElement('div');
    root.className = 'intro-cutscene-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', ariaLabel);

    const video = document.createElement('video');
    video.className = 'intro-cutscene-video';
    video.src = videoSrc;
    video.preload = 'auto';
    video.playsInline = true;
    video.controls = false;
    video.autoplay = true;
    /* Click context from the Begin/New button counts as a user gesture, so audio plays. */

    const skipBtn = document.createElement('button');
    skipBtn.className = 'intro-cutscene-skip';
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip ▶';

    const hint = document.createElement('div');
    hint.className = 'intro-cutscene-hint';
    hint.textContent = 'press SKIP, or Esc / Space / Enter';

    root.append(video, skipBtn, hint);
    parent.appendChild(root);

    let finished = false;
    let mountedAt = performance.now();
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
    let loadTimeoutHandle: number | null = null;

    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      /* DO NOT set the seen-flag here. The flag represents "the player
       * successfully completed the FULL intro chain (curse → start-flow →
       * shattering → mountApp)", not "any single cutscene played". Setting
       * it here would mark seen the moment the curse cutscene ends, so the
       * next refresh skips the curse but the shattering still plays in
       * `enterGame` (because the gate fires AFTER curse-cleanup on the
       * very first visit too) — exactly the partial-state UX the docstring
       * at the top of this file warns against. The single source of truth
       * for `markIntroCutsceneSeen()` is `main.ts` after `mountApp`
       * resolves successfully (search for `markIntroCutsceneSeen` in
       * `src/main.ts`). */
      if (loadTimeoutHandle != null) {
        window.clearTimeout(loadTimeoutHandle);
        loadTimeoutHandle = null;
      }
      /* Stop the video decoder IMMEDIATELY — frees CPU/GPU + audio thread
       * for the heavy mountApp work that's about to run. Without this the
       * decoder kept running through the fade-out (~600ms) competing with
       * scene mount. */
      try {
        video.pause();
        video.removeAttribute('src');
        video.load(); /* finalizes the source detach */
      } catch {
        /* defensive — older browsers may throw on src-removal */
      }
      root.classList.remove('is-visible');
      if (onKeyDown) {
        window.removeEventListener('keydown', onKeyDown);
        onKeyDown = null;
      }
      /* Resolve the promise FIRST so the caller can mount the post-cutscene
       * UI (loading veil) immediately. The DOM removal + fade-out happen
       * in the background — since the veil's z-index is far above the
       * cutscene's, the player sees the veil straight away. */
      try {
        options.onCleanupStart?.();
      } catch {
        /* don't let a bad caller callback strand the cutscene */
      }
      resolve();
      /* Schedule actual DOM removal a frame after the fade transition
       * (kept at 600ms via CSS) so the cutscene visually fades while the
       * next screen is already mounting on top. */
      window.setTimeout(() => {
        root.remove();
      }, 600);
    };

    const trySkip = (): void => {
      if (performance.now() - mountedAt < SKIP_GRACE_MS) return;
      cleanup();
    };

    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
    root.addEventListener('click', () => {
      trySkip();
    });
    onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        cleanup();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    video.addEventListener('ended', cleanup);
    video.addEventListener('error', () => {
      /* If the video can't load, don't strand the player on a black screen. */
      cleanup();
    });
    /* Clear the load-timeout the moment we know the video is decodable
     * (loadeddata fires once the first frame is ready). */
    video.addEventListener('loadeddata', () => {
      if (loadTimeoutHandle != null) {
        window.clearTimeout(loadTimeoutHandle);
        loadTimeoutHandle = null;
      }
    });
    /* Hard safety: if the video never reaches `loadeddata` within the
     * timeout window (slow network, missing file, codec issue), treat as
     * a load failure and proceed to the game so the player isn't stuck
     * on a black screen waiting for an mp4 that may never arrive. */
    loadTimeoutHandle = window.setTimeout(() => {
      loadTimeoutHandle = null;
      if (!finished) cleanup();
    }, VIDEO_LOAD_TIMEOUT_MS);

    /* Show overlay + skip controls after a moment. Skip + hint are made
     * visible IMMEDIATELY (was 1500 ms) so the player sees an obvious skip
     * affordance the instant the cutscene mounts — they can hit the button
     * without guessing or hammering the video area. */
    requestAnimationFrame(() => {
      root.classList.add('is-visible');
      skipBtn.classList.add('is-shown');
      hint.classList.add('is-shown');
      mountedAt = performance.now();
    });

    /* Some browsers reject autoplay even with gesture if loadeddata isn't ready;
     * play() returns a promise we can quietly retry once. */
    void video.play().catch(() => {
      window.setTimeout(() => {
        void video.play().catch(() => {
          /* If autoplay still fails, the user's click on the overlay (or skip) will exit. */
        });
      }, 200);
    });
  });
}
