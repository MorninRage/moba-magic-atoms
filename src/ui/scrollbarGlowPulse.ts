/**
 * Chromium-based browsers do not run @keyframes on ::-webkit-scrollbar-thumb.
 * Toggle html[data-scroll-pulse] so box-shadows that reference CSS variables visibly breathe.
 */
const INTERVAL_MS = 1200;

export function installScrollbarGlowPulse(): void {
  if (typeof document === 'undefined') return;

  const html = document.documentElement;
  html.setAttribute('data-scroll-pulse', 'base');

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  let alt = false;
  window.setInterval(() => {
    alt = !alt;
    html.setAttribute('data-scroll-pulse', alt ? 'alt' : 'base');
  }, INTERVAL_MS);
}
