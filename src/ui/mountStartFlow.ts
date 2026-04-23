/**
 * MOBA start flow: title → mode (**solo practice** or **3v3 online**) → hero preset → game or lobby.
 * This repo is not IDLE-CRAFT: online play is **deathmatch (3v3)** only — no co-op caravan or Hunter 1v1 in UI.
 */
import type { CharacterPresetId, GameMode } from '../core/types';
import { CHARACTER_PRESETS } from '../data/characterPresets';
import type { GameStore } from '../core/gameStore';
import './startFlow.css';
import './app.css';
import startHeroPhoto from '../../assets/ui/start-hero-bg.webp';
import { openIdleCraftConfirm } from './idleCraftConfirmModal';
import { resumeAndStartMusic } from '../audio/audioBridge';
import { getLobbyWebSocketUrl, getRoomHub } from '../net/roomHubBridge';
import { mountOnlineLobby, type DisposeOnlineLobby } from './mountOnlineLobby';

export type MountStartFlowOptions = {
  /** Whether a save exists in localStorage (Continue). */
  hasSave: boolean;
  /** Mount main shell + dock. */
  onEnterGame: () => void;
  /**
   * Fires when the player signals intent to start the game (clicks Begin / New / Continue).
   * Host wires this to the dock preload so scene construction begins **during** the mode /
   * character selection steps, without blocking the initial title paint + first clicks.
   * May fire multiple times; preload is idempotent on the callee side.
   */
  onCommitToPlay?: () => void;
};

type StepId = 'title' | 'mode' | 'character' | 'onlineLobby';

let titleRoomHubUnsub: (() => void) | null = null;
let onlineLobbyCleanup: DisposeOnlineLobby | null = null;
let dockPreloadProgressUnsub: (() => void) | null = null;

/** Call when leaving the start flow (e.g. entering game) so RoomHub title listeners are not duplicated on return. */
export function detachStartFlowRoomHub(): void {
  titleRoomHubUnsub?.();
  titleRoomHubUnsub = null;
  onlineLobbyCleanup?.({ leaveRoom: true });
  onlineLobbyCleanup = null;
  dockPreloadProgressUnsub?.();
  dockPreloadProgressUnsub = null;
}

export function mountStartFlow(root: HTMLElement, store: GameStore, opts: MountStartFlowOptions): void {
  detachStartFlowRoomHub();
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'start-flow';
  wrap.setAttribute('role', 'application');
  wrap.innerHTML = `
    <div class="start-flow-bg-stack" aria-hidden="true">
      <img class="start-flow-bg-photo" alt="" decoding="async" fetchpriority="high" data-start-hero-photo />
      <div class="start-flow-bg-vignette"></div>
      <div class="start-flow-bg-scanlines"></div>
    </div>
    <div class="start-flow-inner">
      <div class="start-hero-panel start-hero-panel--chrome">
        <div class="start-step start-step--active" data-step="title">
          <div class="start-title-brand">
            <div class="start-brand-mark">
              <svg class="start-brand-mark__svg" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <defs>
                  <linearGradient id="start-brand-grad" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                    <stop stop-color="#e1f5fe"/>
                    <stop offset="0.45" stop-color="#4fc3f7"/>
                    <stop offset="1" stop-color="#e8a54b"/>
                  </linearGradient>
                  <filter id="start-brand-glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="1.2" result="b"/>
                    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                  </filter>
                </defs>
                <path filter="url(#start-brand-glow)" fill="url(#start-brand-grad)" opacity="0.95"
                  d="M10 42 L32 20 L54 42 L50 46 L42 40 L42 54 L22 54 L22 40 L14 46 Z"/>
                <rect x="18" y="54" width="28" height="7" rx="1.5" fill="#1a2438" stroke="rgba(129,212,250,0.35)" stroke-width="1"/>
                <circle cx="48" cy="26" r="3" fill="#fff8e8" opacity="0.85"/>
              </svg>
            </div>
            <div class="start-title-copy">
              <p class="start-kicker">Vibe Jam 2026 · MOBA — Magic Orbiting Brandished Atoms</p>
              <h1 class="start-title">MOBA</h1>
              <p class="start-sub">
                <strong>3v3</strong> magic brawl on the procedural forest — FIFO matchmaking on Fly.io. <strong>Solo</strong> is local practice
                (same 3D shell, no lobby). Use <strong>Find 3v3 match</strong> or <code>?queue=3v3</code> after you pick a hero.
              </p>
            </div>
          </div>
          <!-- 2026-04-22 name gate removed (player request); see code comment below -->
          <div class="start-actions" data-title-actions></div>
          <div class="start-preparing" data-start-preparing role="status" aria-live="polite">
            <span class="start-preparing__hex" aria-hidden="true">
              <span class="start-preparing__hex-spin"></span>
              <span class="start-preparing__hex-core"></span>
            </span>
            <span class="start-preparing__copy">
              <span class="start-preparing__label" data-start-preparing-label>Preparing your expedition…</span>
              <span class="start-preparing__bar" aria-hidden="true">
                <span class="start-preparing__fill" data-start-preparing-fill></span>
              </span>
            </span>
          </div>
          <p class="start-footer-note">
            Online is <strong>3v3 only</strong> — six players queue, then teams A/B, ready, host launch. Add <code>?queue=3v3</code> to auto-queue after hero select.
          </p>
          <p class="start-footer-note start-footer-note--room" hidden data-room-hub-status></p>
        </div>

        <div class="start-step" data-step="mode">
          <button type="button" class="start-btn start-btn--neon-ghost start-btn--back" data-back="title">← Back</button>
          <h2 class="start-step-h">How do you want to play?</h2>
          <p class="start-step-p">
            <strong>Solo</strong> — local save, practice in the 3D forest. <strong>3v3 online</strong> — lobby, find match or room code, then host launches; server owns seed and phases.
          </p>
          <div class="start-grid" data-mode-grid></div>
        </div>

        <div class="start-step" data-step="character">
          <button type="button" class="start-btn start-btn--neon-ghost start-btn--back" data-back="mode">← Back</button>
          <h2 class="start-step-h">Hero</h2>
          <p class="start-step-p">
            Procedural presets — LPCA dock rig. Your pick is saved on this device.
          </p>
          <div class="start-grid" data-char-grid></div>
          <div class="start-actions">
            <button type="button" class="start-btn start-btn--neon-primary" data-confirm-char disabled>Enter world</button>
          </div>
        </div>

        <div class="start-step" data-step="onlineLobby">
          <div data-online-lobby-root></div>
        </div>
      </div>
    </div>
  `;
  root.appendChild(wrap);
  const heroImg = wrap.querySelector('[data-start-hero-photo]') as HTMLImageElement | null;
  if (heroImg) heroImg.src = startHeroPhoto;

  const steps = {
    title: wrap.querySelector('[data-step="title"]') as HTMLElement,
    mode: wrap.querySelector('[data-step="mode"]') as HTMLElement,
    character: wrap.querySelector('[data-step="character"]') as HTMLElement,
    onlineLobby: wrap.querySelector('[data-step="onlineLobby"]') as HTMLElement,
  };

  let selectedMode: GameMode = 'solo';
  let selectedChar: CharacterPresetId | null = null;
  const urlQueue = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('queue');
  /** After character confirm, lobby auto-joins 3v3 FIFO matchmaking only. */
  let autoJoinQueueNextLobby = urlQueue === '3v3' || urlQueue === 'deathmatch';

  function showStep(s: StepId): void {
    (Object.keys(steps) as StepId[]).forEach((k) => {
      steps[k].classList.toggle('start-step--active', k === s);
    });
  }

  const titleActions = wrap.querySelector('[data-title-actions]') as HTMLElement;

  /* === 2026-04-22 name gate removed (player request) ===
   *
   * The 2026-04-20 name gate (input + "Check availability" fake-search +
   * confirm button) is gone. It served two purposes that no longer apply:
   *   (1) Persist a display name in `localStorage['moba-atoms-display-name']`
   *       used by `vibejam-portal-exit` in `main.ts` + `mountOnlineLobby.ts`.
   *       Both call sites already fall back to "Survivor" if the key is
   *       missing, so removing the gate degrades to the default name —
   *       multiplayer + portal hand-off still work.
   *   (2) Provide a 1.2-1.8 s UX timing buffer that hid the dock-preload's
   *       wall-clock cost behind the fake-search animation. Without it,
   *       players who land on the title and immediately click Begin will
   *       see the loading veil if the preload hasn't finished yet — but
   *       the always-on early preload kick at module top + the
   *       pre-bind `bindGameStoreToDockPreview` make this rare in practice.
   *
   * If a future session wants to re-introduce a name field, do it as a
   * NON-BLOCKING field (no fake-search delay) somewhere on the title or
   * settings menu, writing to the same `moba-atoms-display-name` key. */

  /**
   * Dock-preload trigger.
   *
   * **Indicator placement:** the `[data-start-preparing]` block lives ONLY on the Title
   * step. An earlier version also showed it on the Mode step, but by the time the player
   * reached Mode the preload was usually already finished — so the indicator just flashed
   * "ready" for a frame and looked redundant. Code still uses `querySelectorAll` so a
   * future second indicator can be added without re-wiring.
   *
   * **Continue compatibility:** putting the indicator on Title (not Mode) is also what
   * makes the Continue path show the indicator at all — Continue skips Mode entirely.
   *
   * **Why preload on first interaction (not on title mount)?** Scene construction is heavy
   * synchronous main-thread work. Kicking it on title MOUNT delayed the first paint /
   * locked button responsiveness for several seconds. Kicking it on the first INTERACTION
   * (mousemove, pointerdown, keydown, touchstart) means the title renders instantly, and
   * preload starts the moment the player even drifts the cursor onto the page — which
   * happens long before they read the buttons and click Continue/Begin/New. That gives
   * Continue the same several-second head start the Begin / New flow naturally enjoys
   * via the Mode + Character selection time.
   *
   * **Fallback:** if no interaction fires within 600 ms (rare — keyboard-only nav, screen
   * readers tabbing straight to a button), we kick the preload anyway via a timeout so
   * Continue still benefits. 600 ms is comfortably after first paint (~50–150 ms) but
   * shaves ~900 ms off the previous 1500 ms wait for accessibility users.
   */
  const preparingEls = Array.from(
    wrap.querySelectorAll('[data-start-preparing]'),
  ) as HTMLElement[];
  const preparingLabels = Array.from(
    wrap.querySelectorAll('[data-start-preparing-label]'),
  ) as HTMLElement[];
  const preparingFills = Array.from(
    wrap.querySelectorAll('[data-start-preparing-fill]'),
  ) as HTMLElement[];

  const setPreparingVisible = (visible: boolean): void => {
    preparingEls.forEach((el) => el.classList.toggle('start-preparing--visible', visible));
  };

  let preloadKicked = false;
  const commitToPlay = (): void => {
    setPreparingVisible(true);
    preparingLabels.forEach((el) => {
      el.textContent = 'Preparing your expedition…';
    });
    preparingFills.forEach((el) => {
      el.style.transform = 'scaleX(0)';
    });
    preparingEls.forEach((el) => {
      el.classList.remove('start-preparing--ready');
      el.classList.add('start-preparing--indeterminate');
    });
    if (preloadKicked) return;
    preloadKicked = true;
    setTimeout(() => {
      opts.onCommitToPlay?.();
      /* Single subscribe: `dockPreload` already maps scene foundation + gameplay
       * attach to one 0..1 progress stream with phase labels. A second subscribe
       * to `dockExtendedPreload` used to merge two 0..1 streams with a 0.55/0.45
       * split — but the dock stream was *already* fully scaled, so that merged
       * bar under-reported progress mid-load. */
      void import('../engine/dockPreload').then(({ subscribeIdleCraftDockPreloadProgress }) => {
        dockPreloadProgressUnsub?.();
        dockPreloadProgressUnsub = subscribeIdleCraftDockPreloadProgress((p) => {
          /* Legacy preload may set `ready` once the dock preview exists while gameplay
           * layers still attach — green state + "choose a mode" only when bar hits 1. */
          const layersFullyReady = p.fraction >= 1 - 1e-6;
          const activePhase = layersFullyReady
            ? 'Expedition ready — choose a mode'
            : (p.phase || 'Preparing your expedition…');
          preparingEls.forEach((el) => {
            el.classList.remove('start-preparing--indeterminate');
            el.classList.toggle('start-preparing--ready', layersFullyReady);
          });
          preparingLabels.forEach((el) => {
            el.textContent = activePhase;
          });
          preparingFills.forEach((el) => {
            el.style.transform = `scaleX(${Math.max(0.02, Math.min(1, p.fraction))})`;
          });
        });
      });
    }, 0);
  };

  /*
   * One-shot first-interaction kick. Any of these gestures triggers commitToPlay()
   * exactly once, then the listeners detach. Captured in CAPTURE phase so the title
   * buttons' own click handlers (which also call commitToPlay) still work — both paths
   * are idempotent thanks to the `preloadKicked` guard above.
   */
  const FIRST_INTERACTION_EVENTS = [
    'pointerdown',
    'pointermove',
    'keydown',
    'touchstart',
    'wheel',
  ] as const;
  const onFirstInteraction = (): void => {
    detachFirstInteraction();
    commitToPlay();
  };
  const detachFirstInteraction = (): void => {
    FIRST_INTERACTION_EVENTS.forEach((ev) => {
      wrap.removeEventListener(ev, onFirstInteraction, true);
    });
    if (firstInteractionFallback != null) {
      window.clearTimeout(firstInteractionFallback);
      firstInteractionFallback = null;
    }
  };
  FIRST_INTERACTION_EVENTS.forEach((ev) => {
    wrap.addEventListener(ev, onFirstInteraction, { passive: true, capture: true });
  });
  /* Fallback for keyboard-only / screen-reader users who tab straight to a button without
   * triggering pointer/keydown on the wrap. 600 ms is comfortably after first paint
   * (~50–150 ms) so it doesn't compete with title rendering, but trims ~900 ms off the
   * previous 1500 ms wait for accessibility users. */
  let firstInteractionFallback: number | null = window.setTimeout(() => {
    firstInteractionFallback = null;
    onFirstInteraction();
  }, 600);

  if (opts.hasSave) {
    const cont = document.createElement('button');
    cont.type = 'button';
    cont.className = 'start-btn start-btn--neon-primary';
    cont.textContent = 'Continue expedition';
    cont.addEventListener('click', () => {
      commitToPlay();
      store.resumeIntoMobaShell();
      opts.onEnterGame();
    });
    titleActions.appendChild(cont);

    const neu = document.createElement('button');
    neu.type = 'button';
    neu.className = 'start-btn start-btn--neon-primary';
    neu.textContent = 'New expedition';
    neu.addEventListener('click', () => {
      void openIdleCraftConfirm({
        title: 'Start a new expedition?',
        message:
          'This clears your local save on this device — inventory, crafted gear, idle slots, and run history. Your survivor preset choice comes next.',
        confirmLabel: 'Wipe save & continue',
        cancelLabel: 'Keep my expedition',
        variant: 'danger',
      }).then((ok) => {
        if (ok) {
          store.reset();
          commitToPlay();
          showStep('mode');
        }
      });
    });
    titleActions.appendChild(neu);
  } else {
    const begin = document.createElement('button');
    begin.type = 'button';
    begin.className = 'start-btn start-btn--neon-primary';
    begin.textContent = 'Begin new expedition';
    begin.addEventListener('click', () => {
      commitToPlay();
      showStep('mode');
    });
    titleActions.appendChild(begin);
  }

  const quick3v3 = document.createElement('button');
  quick3v3.type = 'button';
  quick3v3.className = 'start-btn start-btn--neon-primary';
  quick3v3.textContent = 'Find 3v3 match';
  quick3v3.addEventListener('click', () => {
    commitToPlay();
    selectedMode = 'deathmatch';
    store.setGameMode('deathmatch');
    autoJoinQueueNextLobby = true;
    selectedChar = store.getState().characterPresetId;
    showStep('character');
    syncCharSelection();
    updateConfirmLabel();
  });
  titleActions.prepend(quick3v3);

  const modeGrid = wrap.querySelector('[data-mode-grid]') as HTMLElement;
  const modes: { id: GameMode; title: string; desc: string }[] = [
    {
      id: 'solo',
      title: 'Solo practice',
      desc: 'Local save — explore the 3D forest, combat, and systems without matchmaking.',
    },
    {
      id: 'deathmatch',
      title: '3v3 online',
      desc: 'FIFO matchmaking: six players → teams A/B → ready, host lock, launch. Browse or create a room instead if you prefer.',
    },
  ];

  for (const m of modes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'start-card start-card--playable';
    card.innerHTML = `
      <div class="start-card-meta">${m.id === 'solo' ? 'Local' : 'Fly.io lobby · 3v3'}</div>
      <h3 class="start-card-title">${m.title}</h3>
      <p class="start-card-desc">${m.desc}</p>
    `;
    card.addEventListener('click', () => {
      selectedMode = m.id;
      store.setGameMode(m.id);
      selectedChar = store.getState().characterPresetId;
      showStep('character');
      syncCharSelection();
      updateConfirmLabel();
    });
    modeGrid.appendChild(card);
  }

  const charGrid = wrap.querySelector('[data-char-grid]') as HTMLElement;
  const confirmChar = wrap.querySelector('[data-confirm-char]') as HTMLButtonElement;

  function updateConfirmLabel(): void {
    confirmChar.textContent = selectedMode === 'solo' ? 'Enter world' : 'Continue to lobby';
  }

  function syncCharSelection(): void {
    const cards = charGrid.querySelectorAll('.start-card[data-char-id]');
    cards.forEach((el) => {
      const id = el.getAttribute('data-char-id') as CharacterPresetId;
      el.classList.toggle('start-card--selected', id === selectedChar);
    });
    confirmChar.disabled = selectedChar == null;
  }

  for (const p of CHARACTER_PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'start-card start-card--playable';
    card.dataset.charId = p.id;
    card.innerHTML = `
      <div class="start-card-meta">${p.title}</div>
      <h3 class="start-card-title">${p.name}</h3>
      <p class="start-card-desc">${p.tagline}</p>
    `;
    card.addEventListener('click', () => {
      selectedChar = p.id;
      store.setCharacterPreset(p.id);
      syncCharSelection();
    });
    charGrid.appendChild(card);
  }

  confirmChar.addEventListener('click', () => {
    void (async () => {
      if (!selectedChar) return;
      store.setCharacterPreset(selectedChar);
      store.setGameMode(selectedMode);
      if (selectedMode === 'solo') {
        store.clearOnlineSession();
        store.beginSoloMobaMatch();
        opts.onEnterGame();
        return;
      }
      onlineLobbyCleanup?.({ leaveRoom: true });
      const lobbyRoot = wrap.querySelector('[data-online-lobby-root]') as HTMLElement;
      lobbyRoot.replaceChildren();
      if (autoJoinQueueNextLobby) {
        selectedMode = 'deathmatch';
        store.setGameMode('deathmatch');
      }
      onlineLobbyCleanup = await mountOnlineLobby(lobbyRoot, {
        gameMode: selectedMode,
        characterPresetId: selectedChar,
        autoJoinQueue: autoJoinQueueNextLobby && selectedMode === 'deathmatch',
        onBack: () => {
          onlineLobbyCleanup?.({ leaveRoom: true });
          onlineLobbyCleanup = null;
          showStep('character');
        },
        onEnterGame: (session) => {
          onlineLobbyCleanup?.({ leaveRoom: false });
          onlineLobbyCleanup = null;
          store.beginOnlineSession({ ...session, sessionKind: 'moba_match' });
          opts.onEnterGame();
        },
      });
      autoJoinQueueNextLobby = false;
      showStep('onlineLobby');
    })();
  });

  wrap.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-back') as StepId;
      showStep(target);
    });
  });

  /* If no save, user still needs mode + char; if they hit Back from mode to title with no save, title only has Begin */
  showStep('title');

  const roomWsUrl = getLobbyWebSocketUrl();
  const roomStatusEl = wrap.querySelector('[data-room-hub-status]') as HTMLElement | null;
  if (roomStatusEl && roomWsUrl) {
    roomStatusEl.hidden = false;
    titleRoomHubUnsub = getRoomHub().subscribeConnection((state, detail) => {
      if (state === 'open') {
        roomStatusEl.textContent =
          'Online lobby is ready — pick 3v3 online (or Find 3v3 match on the title) to queue.';
      } else if (state === 'connecting') {
        roomStatusEl.textContent = 'Connecting to the online lobby…';
      } else if (state === 'error') {
        roomStatusEl.textContent = `Online lobby error${detail ? `: ${detail}` : ''}. Check your connection and try again.`;
      } else if (state === 'closed') {
        roomStatusEl.textContent = 'Online lobby connection closed. Try refreshing the page.';
      } else {
        roomStatusEl.textContent = '';
      }
    });
  }

  /* Warm decode + transport while title paints; browsers still need a tap for AudioContext.resume(), but music begins on the first pointer/touch/key, not only on Continue. */
  void resumeAndStartMusic();
}
