import './app.css';
import './systemMenu.css';
import systemMenuBg from '../../assets/ui/system-menu-bg.webp';
import {
  mountAudioPanel,
  refreshAudioControlLabels,
  resumeAndStartMusic,
  syncMusicThemeFromTransport,
} from '../audio/gameAudio';
import { MUSIC_LIBRARY_LINKS, SHIPPED_MUSIC_CREDITS } from '../audio/musicManifest';
import { refreshPostProcessingPanel, wirePostProcessingPanel } from './systemMenuGraphicsPanel';
import { refreshLightingPanel, wireLightingPanel } from './systemMenuLightingPanel';
import { installControlsPopup } from './systemMenuControlsPanel';
import {
  applyGraphicsHelpLines,
  getGraphicsHelpEnabled,
  setGraphicsHelpEnabled,
} from './graphicsHelpSettings';
import {
  FPS_CAP_UNCAPPED,
  getIdleCraftFps,
  getIdleCraftFpsCap,
  getIdleCraftFrameMs,
  isIdleCraftFpsHudVisible,
  setIdleCraftFpsCap,
  setIdleCraftFpsHudVisible,
} from './fpsMonitor';

export type InstallSystemMenuOpts = {
  /** True when main game shell (#app-shell) is mounted. */
  isInGame: () => boolean;
  /** Leave run and show title / start flow (save persists). */
  onReturnToTitle: () => void;
};

export type OpenCampSystemMenuOpts = {
  /** Scroll the Esc panel to the graphics / post-processing block. */
  focusGraphics?: boolean;
};

let systemMenuShellRef: HTMLElement | null = null;
let openCampMenuImpl: (() => void) | null = null;

/** Open the global Esc menu (same as pressing Esc). Optional scroll to graphics. */
export function openCampSystemMenu(opts?: OpenCampSystemMenuOpts): void {
  openCampMenuImpl?.();
  if (opts?.focusGraphics && systemMenuShellRef) {
    const el = systemMenuShellRef.querySelector('[data-system-graphics-pp]');
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/** Late-bound from mountApp after CharacterScenePreview exists; cleared on return to title. */
let characterCameraResetFn: (() => void) | null = null;

export function registerCharacterCameraForSystemMenu(fn: (() => void) | null): void {
  characterCameraResetFn = fn;
}

/**
 * Global ESC menu: audio controls, soundtrack resources, optional credits, resume, return to title.
 */
export function installSystemMenu(opts: InstallSystemMenuOpts): void {
  const shell = document.createElement('div');
  shell.id = 'system-menu-overlay';
  shell.className = 'system-menu';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-labelledby', 'system-menu-title');
  shell.innerHTML = `
    <div class="system-menu__bg-stack" aria-hidden="true">
      <img class="system-menu__photo" alt="" decoding="async" data-system-menu-photo />
      <div class="system-menu__vignette"></div>
      <div class="system-menu__scanlines"></div>
    </div>
    <button type="button" class="system-menu__backdrop" data-system-menu-backdrop data-audio-skip aria-label="Close menu"></button>
    <div class="system-menu__panel">
      <p class="system-menu__kicker">Idle Craft</p>
      <h2 id="system-menu-title" class="system-menu__title">Camp relay</h2>
      <div class="system-menu__actions">
        <button type="button" class="system-menu__btn system-menu__btn--primary" data-system-resume>Resume</button>
        <button type="button" class="system-menu__btn system-menu__btn--ghost" data-system-controls-open>Controls reference</button>
        <button type="button" class="system-menu__btn system-menu__btn--danger" data-system-title style="display:none">Return to main menu</button>
      </div>
      <div class="system-menu__camera-block" data-system-camera-block hidden>
        <p class="system-menu__section-title">Character camera</p>
        <ul class="system-menu__camera-list">
          <li><strong>Orbit</strong> — left-drag on the 3D view (drag up looks up; drag right orbits right).</li>
          <li><strong>Pan</strong> — right-drag, or Shift + left-drag (grab the scene).</li>
          <li><strong>Zoom</strong> — mouse wheel (scroll up = closer to character).</li>
          <li><strong>Quick reset</strong> — double-click the 3D view, or use the button below.</li>
        </ul>
        <button type="button" class="system-menu__btn system-menu__btn--ghost" data-system-reset-camera>
          Reset camera to default
        </button>
      </div>
      <div class="system-menu__graphics-pp" data-system-performance>
        <p class="system-menu__section-title">Performance</p>
        <p class="system-menu__hint">
          The game runs at your display refresh rate by default. Live readout
          updates while this menu is open.
        </p>
        <div class="system-menu__perf-readout" data-perf-readout aria-live="polite">
          <span class="system-menu__perf-fps" data-perf-fps>FPS …</span>
          <span class="system-menu__perf-ms" data-perf-ms>… ms</span>
        </div>
        <label class="system-menu__checkline">
          <input type="checkbox" data-perf-hud />
          Show FPS overlay in corner
        </label>
        <label class="system-menu__field">
          <span>Frame-rate cap</span>
          <select data-perf-cap class="system-menu__select" aria-label="Frame-rate cap">
            <option value="0">Uncapped (display rate)</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
            <option value="90">90 fps</option>
            <option value="120">120 fps</option>
            <option value="144">144 fps</option>
          </select>
        </label>
      </div>
      <div class="system-menu__graphics-pp" data-system-graphics-pp>
        <label class="system-menu__checkline system-menu__checkline--help-toggle">
          <input type="checkbox" data-graphics-help-toggle />
          Show explanations for graphics &amp; lighting
        </label>
        <p class="system-menu__section-title">Graphics quality</p>
        <p class="system-menu__hint">Tier affects terrain, shadows, vegetation, and more. Reload after changing.</p>
        <label class="system-menu__field" data-help-id="gfx-tier">
          <span>Performance tier</span>
          <select data-graphics-tier class="system-menu__select" aria-label="Graphics performance tier">
            <option value="auto">Auto (device default)</option>
            <option value="high">High</option>
            <option value="low">Low / mobile</option>
          </select>
        </label>
        <button type="button" class="system-menu__btn system-menu__btn--ghost" data-graphics-reload>
          Reload page to apply tier
        </button>
        <p class="system-menu__section-title">Post-processing</p>
        <p class="system-menu__hint" data-pp-tier-hint></p>
        <div class="system-menu__preset-row" role="group" aria-label="Quality presets" data-help-id="gfx-presets">
          <button type="button" class="system-menu__chip" data-pp-preset="low">Low</button>
          <button type="button" class="system-menu__chip" data-pp-preset="medium">Medium</button>
          <button type="button" class="system-menu__chip" data-pp-preset="high">High</button>
          <button type="button" class="system-menu__chip" data-pp-preset="veryhigh">Very high</button>
          <button type="button" class="system-menu__chip" data-pp-preset="ultra">Ultra</button>
        </div>
        <label class="system-menu__checkline" data-help-id="gfx-heavy-low"><input type="checkbox" data-pp-heavy /> Allow bloom &amp; SSAO on low power</label>
        <label class="system-menu__checkline" data-help-id="pp-fxaa"><input type="checkbox" data-pp-fxaa /> FXAA</label>
        <div class="system-menu__slider-row" data-help-id="pp-fxaa-strength">
          <span>FXAA strength <output data-pp-val-fxaa-strength>0.08</output></span>
          <input type="range" data-pp-range-fxaa-strength min="0" max="1" step="0.01" aria-label="FXAA strength" />
        </div>
        <label class="system-menu__checkline" data-help-id="pp-vignette"><input type="checkbox" data-pp-vignette /> Vignette</label>
        <label class="system-menu__checkline" data-help-id="pp-bloom"><input type="checkbox" data-pp-bloom /> Bloom</label>
        <label class="system-menu__checkline" data-help-id="pp-ssao"><input type="checkbox" data-pp-ssao /> SSAO (ambient occlusion)</label>
        <div class="system-menu__slider-row" data-help-id="pp-bloom-strength">
          <span>Bloom strength <output data-pp-val-bloom-strength>0.03</output></span>
          <input type="range" data-pp-range-bloom-strength min="0" max="1" step="0.01" aria-label="Bloom strength" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-bloom-threshold">
          <span>Bloom threshold <output data-pp-val-bloom-threshold>0.08</output></span>
          <input type="range" data-pp-range-bloom-threshold min="0" max="1" step="0.01" aria-label="Bloom threshold" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-bloom-radius">
          <span>Bloom radius <output data-pp-val-bloom-radius>0.25</output></span>
          <input type="range" data-pp-range-bloom-radius min="0" max="1" step="0.01" aria-label="Bloom radius" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-vignette-darkness">
          <span>Vignette darkness <output data-pp-val-vignette-darkness>0.15</output></span>
          <input type="range" data-pp-range-vignette-darkness min="0" max="1.5" step="0.01" aria-label="Vignette darkness" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-vignette-offset">
          <span>Vignette offset <output data-pp-val-vignette-offset>1.20</output></span>
          <input type="range" data-pp-range-vignette-offset min="0.5" max="2" step="0.01" aria-label="Vignette offset" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-ssao-intensity">
          <span>SSAO intensity <output data-pp-val-ssao-intensity>0.38</output></span>
          <input type="range" data-pp-range-ssao-intensity min="0" max="0.5" step="0.01" aria-label="SSAO intensity" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-ssao-radius">
          <span>SSAO kernel radius <output data-pp-val-ssao-radius>1.30</output></span>
          <input type="range" data-pp-range-ssao-radius min="0" max="2" step="0.05" aria-label="SSAO kernel radius" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-ssao-min-distance">
          <span>SSAO min distance <output data-pp-val-ssao-min-distance>0.066</output></span>
          <input type="range" data-pp-range-ssao-min-distance min="0.001" max="0.1" step="0.001" aria-label="SSAO min distance" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-ssao-max-distance">
          <span>SSAO max distance <output data-pp-val-ssao-max-distance>0.158</output></span>
          <input type="range" data-pp-range-ssao-max-distance min="0.005" max="0.25" step="0.001" aria-label="SSAO max distance" />
        </div>
        <div class="system-menu__slider-row" data-help-id="pp-ssao-resolution-scale">
          <span>SSAO resolution scale <output data-pp-val-ssao-resolution-scale>0.75</output></span>
          <input type="range" data-pp-range-ssao-resolution-scale min="0.1" max="1" step="0.05" aria-label="SSAO resolution scale" />
        </div>
        <p class="system-menu__hint system-menu__hint--small">
          SSAO sample count (<code>ssaoKernelSize</code> in <code>project.json</code>) applies on load; reload after editing.
        </p>
        <button type="button" class="system-menu__btn system-menu__btn--ghost" data-pp-reset>
          Reset post-processing overrides
        </button>
      </div>
      <div class="system-menu__graphics-pp system-menu__lighting-block" data-system-lighting>
        <p class="system-menu__section-title">Lighting &amp; color</p>
        <label class="system-menu__field" data-help-id="lit-tone">
          <span>Tone mapping</span>
          <select data-light-tone class="system-menu__select" aria-label="Tone mapping">
            <option value="ACESFilmic">ACES Filmic</option>
            <option value="NoToneMapping">None</option>
            <option value="Linear">Linear</option>
            <option value="Reinhard">Reinhard</option>
            <option value="Cineon">Cineon</option>
            <option value="AgX">AgX</option>
            <option value="Neutral">Neutral</option>
          </select>
        </label>
        <label class="system-menu__field" data-help-id="lit-output">
          <span>Output color space</span>
          <select data-light-output class="system-menu__select" aria-label="Output color space">
            <option value="srgb">sRGB</option>
            <option value="linear">Linear sRGB</option>
          </select>
        </label>
        <div class="system-menu__slider-row" data-help-id="lit-exposure">
          <span>Exposure (base) <output data-light-val-exposure>2.25</output></span>
          <input type="range" data-light-range-exposure min="0.25" max="3" step="0.05" aria-label="Exposure" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-sun">
          <span>Sun intensity <output data-light-val-sun>2.00</output></span>
          <input type="range" data-light-range-sun min="0.5" max="2.5" step="0.05" aria-label="Sun intensity" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-ambient">
          <span>Ambient brightness <output data-light-val-ambient>2.00</output></span>
          <input type="range" data-light-range-ambient min="0.5" max="2.5" step="0.05" aria-label="Ambient brightness" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-hemi">
          <span>Hemisphere fill <output data-light-val-hemi>1.00</output></span>
          <input type="range" data-light-range-hemi min="0.5" max="2" step="0.05" aria-label="Hemisphere fill" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-moon">
          <span>Moonlight strength <output data-light-val-moon>2.00</output></span>
          <input type="range" data-light-range-moon min="0" max="2.5" step="0.05" aria-label="Moonlight strength" />
        </div>
        <label class="system-menu__field" data-help-id="lit-awakened-quality">
          <span>Awakened quality</span>
          <select data-light-awakened-quality class="system-menu__select" aria-label="Awakened quality">
            <option value="perf">Performance — fastest</option>
            <option value="balanced">Balanced — bloom on, no SSAO (default)</option>
            <option value="full">Full — same as dream mode (heaviest)</option>
          </select>
        </label>
        <p class="system-menu__section-subtitle">Ground-level lighting (Phase 8h)</p>
        <div class="system-menu__slider-row" data-help-id="lit-camera-fill">
          <span>Camera fill light <output data-light-val-camera-fill>1.00</output></span>
          <input type="range" data-light-range-camera-fill min="0" max="2" step="0.05" aria-label="Camera fill light" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-night-grade">
          <span>Night grade strength <output data-light-val-night-grade>1.00</output></span>
          <input type="range" data-light-range-night-grade min="0" max="1.5" step="0.05" aria-label="Night grade strength" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-sun-shafts">
          <span>Sun shafts (god-rays) <output data-light-val-sun-shafts>1.00</output></span>
          <input type="range" data-light-range-sun-shafts min="0" max="2" step="0.05" aria-label="Sun shafts" />
        </div>
        <div class="system-menu__slider-row" data-help-id="lit-env-reflections">
          <span>Environment reflections <output data-light-val-env-reflections>1.00</output></span>
          <input type="range" data-light-range-env-reflections min="0" max="1.5" step="0.05" aria-label="Environment reflections" />
        </div>
        <button type="button" class="system-menu__btn system-menu__btn--ghost" data-light-reset>
          Reset lighting &amp; color overrides
        </button>
      </div>
      <p class="system-menu__section-title">Soundtrack</p>
      <ul class="system-menu__links" data-system-lib-links></ul>
      <div data-system-audio-mount></div>
      <p class="system-menu__section-title">Music credits</p>
      <div class="system-menu__credits" data-system-credits></div>
    </div>
  `;

  const photo = shell.querySelector('[data-system-menu-photo]') as HTMLImageElement;
  photo.src = systemMenuBg;

  const titleBtn = shell.querySelector('[data-system-title]') as HTMLButtonElement;
  const resumeBtn = shell.querySelector('[data-system-resume]') as HTMLButtonElement;
  const backdrop = shell.querySelector('[data-system-menu-backdrop]') as HTMLButtonElement;
  const titleHeading = shell.querySelector('#system-menu-title') as HTMLElement;
  const linksRoot = shell.querySelector('[data-system-lib-links]') as HTMLElement;
  const creditsRoot = shell.querySelector('[data-system-credits]') as HTMLElement;
  const audioMount = shell.querySelector('[data-system-audio-mount]') as HTMLElement;
  const cameraBlock = shell.querySelector('[data-system-camera-block]') as HTMLElement;
  const resetCameraBtn = shell.querySelector('[data-system-reset-camera]') as HTMLButtonElement;

  /* Performance section — live FPS readout + HUD toggle + frame cap select. */
  const perfFpsEl = shell.querySelector('[data-perf-fps]') as HTMLElement;
  const perfMsEl = shell.querySelector('[data-perf-ms]') as HTMLElement;
  const perfHudInput = shell.querySelector('[data-perf-hud]') as HTMLInputElement;
  const perfCapSelect = shell.querySelector('[data-perf-cap]') as HTMLSelectElement;
  let perfReadoutTimer: number | null = null;
  function refreshPerfReadout(): void {
    perfFpsEl.textContent = `FPS ${getIdleCraftFps().toFixed(0)}`;
    perfMsEl.textContent = `${getIdleCraftFrameMs().toFixed(1)} ms / frame`;
  }
  function startPerfReadoutPolling(): void {
    refreshPerfReadout();
    if (perfReadoutTimer != null) return;
    perfReadoutTimer = window.setInterval(refreshPerfReadout, 250);
  }
  function stopPerfReadoutPolling(): void {
    if (perfReadoutTimer == null) return;
    window.clearInterval(perfReadoutTimer);
    perfReadoutTimer = null;
  }
  perfHudInput.addEventListener('change', () => {
    setIdleCraftFpsHudVisible(perfHudInput.checked);
  });
  perfCapSelect.addEventListener('change', () => {
    const v = parseInt(perfCapSelect.value, 10);
    setIdleCraftFpsCap(Number.isFinite(v) && v > 0 ? v : FPS_CAP_UNCAPPED);
  });

  for (const { label, href } of MUSIC_LIBRARY_LINKS) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    li.appendChild(a);
    linksRoot.appendChild(li);
  }

  function renderCredits(): void {
    if (SHIPPED_MUSIC_CREDITS.length === 0) {
      creditsRoot.innerHTML =
        '<p style="margin:0">No shipped credits yet. When you add CC BY (or similar) music, edit <code>SHIPPED_MUSIC_CREDITS</code> in <code>musicManifest.ts</code>.</p>';
      return;
    }
    creditsRoot.innerHTML =
      '<strong>Attribution</strong><ul>' +
      SHIPPED_MUSIC_CREDITS.map((c) => {
        const link = c.href
          ? ` <a href="${c.href}" target="_blank" rel="noopener noreferrer">source</a>`
          : '';
        return `<li>${c.line}${link}</li>`;
      }).join('') +
      '</ul>';
  }
  renderCredits();

  let audioMounted = false;
  function ensureAudioPanel(): void {
    if (audioMounted) return;
    mountAudioPanel(audioMount);
    audioMounted = true;
  }

  let lastFocus: HTMLElement | null = null;

  function openMenu(): void {
    ensureAudioPanel();
    refreshAudioControlLabels();
    void resumeAndStartMusic().then(() => {
      syncMusicThemeFromTransport();
      refreshAudioControlLabels();
    });

    const inGame = opts.isInGame();
    titleBtn.style.display = inGame ? 'block' : 'none';
    titleHeading.textContent = inGame ? 'Camp relay' : 'Frontier desk';
    cameraBlock.hidden = !inGame;
    resetCameraBtn.disabled = !inGame || !characterCameraResetFn;

    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }

    shell.classList.add('system-menu--open');
    shell.setAttribute('aria-hidden', 'false');
    mobileMenuBtn.setAttribute('aria-expanded', 'true');
    /* Sync performance controls to current state, then start the live readout poll. */
    perfHudInput.checked = isIdleCraftFpsHudVisible();
    perfCapSelect.value = String(getIdleCraftFpsCap());
    startPerfReadoutPolling();
    refreshPostProcessingPanel(shell);
    refreshLightingPanel(shell);
    const helpToggle = shell.querySelector('[data-graphics-help-toggle]') as HTMLInputElement | null;
    if (helpToggle) helpToggle.checked = getGraphicsHelpEnabled();
    applyGraphicsHelpLines(shell);
    lastFocus = document.activeElement as HTMLElement;
    resumeBtn.focus();
  }

  function closeMenu(): void {
    shell.classList.remove('system-menu--open');
    shell.setAttribute('aria-hidden', 'true');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
    stopPerfReadoutPolling();
    lastFocus?.focus?.();
    lastFocus = null;
  }

  /** Same rules as Escape: close if open; else open unless confirm/death modal is up. */
  function toggleOrOpenMenuFromUi(): void {
    if (shell.classList.contains('system-menu--open')) {
      closeMenu();
      return;
    }
    if (document.querySelector('.idlecraft-confirm')) return;
    if (document.querySelector('.death-modal--open')) return;
    openMenu();
  }

  resumeBtn.addEventListener('click', () => closeMenu());
  backdrop.addEventListener('click', () => closeMenu());
  titleBtn.addEventListener('click', () => {
    closeMenu();
    opts.onReturnToTitle();
  });

  resetCameraBtn.addEventListener('click', () => {
    characterCameraResetFn?.();
    closeMenu();
  });

  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      if (shell.classList.contains('system-menu--open')) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      }

      if (document.querySelector('.idlecraft-confirm')) return;
      if (document.querySelector('.death-modal--open')) return;
      /* Two-step Esc when awakened-mode camera-lock is active (player feedback):
       *   1. First Esc -> browser releases pointer lock; cameraLockController drops
       *      `body.camera-locked` (handled via deactivate / pointerlockchange).
       *   2. Second Esc -> body class is gone, this guard passes, menu opens.
       * Without this guard the menu would pop open ON the same Esc that released
       * the mouse, so the player couldn't separate the two intents.
       *
       * (The class is added/removed by `cameraLockController.ts` activate/deactivate
       * and the pointerlockchange handler — see those methods for the contract.) */
      if (document.body.classList.contains('camera-locked')) return;

      e.preventDefault();
      e.stopPropagation();
      openMenu();
    },
    true,
  );

  const mobileMenuBtn = document.createElement('button');
  mobileMenuBtn.type = 'button';
  mobileMenuBtn.className = 'mobile-system-menu-fab';
  mobileMenuBtn.setAttribute('aria-label', 'Open camp menu');
  mobileMenuBtn.setAttribute('aria-expanded', 'false');
  mobileMenuBtn.title = 'Menu — same as Esc';
  mobileMenuBtn.textContent = 'Esc';
  mobileMenuBtn.addEventListener('click', () => {
    toggleOrOpenMenuFromUi();
  });
  document.body.appendChild(mobileMenuBtn);

  wirePostProcessingPanel(shell);
  wireLightingPanel(shell);
  /* Controls reference is now its own popup that mounts on top of the Esc
   * menu when the player clicks the "Controls reference" button. The popup's
   * own Esc handler dismisses just the popup, leaving the Esc menu still
   * open underneath. See `installControlsPopup` for the layering details. */
  const controlsPopup = installControlsPopup();
  const controlsOpenBtn = shell.querySelector('[data-system-controls-open]') as HTMLButtonElement | null;
  controlsOpenBtn?.addEventListener('click', () => controlsPopup.open());

  const helpToggleEl = shell.querySelector('[data-graphics-help-toggle]') as HTMLInputElement | null;
  if (helpToggleEl) helpToggleEl.checked = getGraphicsHelpEnabled();
  helpToggleEl?.addEventListener('change', (e) => {
    setGraphicsHelpEnabled((e.target as HTMLInputElement).checked);
    applyGraphicsHelpLines(shell);
  });

  systemMenuShellRef = shell;
  openCampMenuImpl = openMenu;

  shell.setAttribute('aria-hidden', 'true');
  document.body.appendChild(shell);
}
