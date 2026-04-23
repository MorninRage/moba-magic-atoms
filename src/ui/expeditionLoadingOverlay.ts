import './expeditionLoadingOverlay.css';
import gameShellBg from '../../assets/ui/game-shell-bg.webp';

export type ExpeditionLoadingHandle = {
  setProgress(fraction: number, status: string): void;
  remove(): void;
};

/** Full-screen Idle Craft forging veil — hex-chamfer PBR meter + shell texture. */
export function mountExpeditionLoading(root: HTMLElement): ExpeditionLoadingHandle {
  const wrap = document.createElement('div');
  wrap.className = 'expedition-loading';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.setAttribute('aria-busy', 'true');
  wrap.style.setProperty('--expedition-shell-texture', `url(${gameShellBg})`);

  wrap.innerHTML = `
    <div class="expedition-loading__mesh" aria-hidden="true"></div>
    <div class="expedition-loading__panel">
      <div class="expedition-loading__brand">
        <svg class="expedition-loading__mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="eload-grad" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
              <stop stop-color="#b8e0ff"/>
              <stop offset="0.5" stop-color="#5eb0e8"/>
              <stop offset="1" stop-color="#d4a85c"/>
            </linearGradient>
          </defs>
          <path fill="url(#eload-grad)" opacity="0.95"
            d="M10 42 L32 20 L54 42 L50 46 L42 40 L42 54 L22 54 L22 40 L14 46 Z"/>
          <rect x="18" y="54" width="28" height="7" rx="1.5" fill="#1a2438" stroke="rgba(129,212,250,0.35)" stroke-width="1"/>
        </svg>
        <div class="expedition-loading__titles">
          <p class="expedition-loading__kicker">Forging camp</p>
          <h2 class="expedition-loading__title">Idle Craft</h2>
        </div>
      </div>
      <p class="expedition-loading__status" data-eload-status>Preparing expedition…</p>

      <div class="eload-meter" aria-hidden="true">
        <div class="eload-meter__bloom"></div>
        <div class="eload-meter__track">
          <div class="eload-meter__fill" data-eload-fill></div>
          <div class="eload-meter__scan"></div>
          <div class="eload-meter__hotspot"></div>
        </div>
      </div>

      <div class="expedition-loading__pct" data-eload-pct>0%</div>
    </div>
  `;
  root.appendChild(wrap);

  const fill = wrap.querySelector('[data-eload-fill]') as HTMLElement;
  const statusEl = wrap.querySelector('[data-eload-status]') as HTMLElement;
  const pctEl = wrap.querySelector('[data-eload-pct]') as HTMLElement;
  let last = 0;

  return {
    setProgress(fraction: number, status: string): void {
      const f = Math.max(0, Math.min(1, fraction));
      last = Math.max(last, f);
      fill.style.transform = `scaleX(${last})`;
      statusEl.textContent = status;
      pctEl.textContent = `${Math.round(last * 100)}%`;
    },
    remove(): void {
      wrap.setAttribute('aria-busy', 'false');
      wrap.classList.add('expedition-loading--out');
      /* Matches the shortened `opacity`/`visibility` transition in expeditionLoadingOverlay.css
       * (220 ms). Keeps a small margin so the DOM remove happens after the fade completes. */
      window.setTimeout(() => wrap.remove(), 260);
    },
  };
}
