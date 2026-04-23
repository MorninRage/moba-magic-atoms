/**
 * Esc menu — optional inline explanations for graphics / post-processing / lighting controls.
 * Persisted so players can turn tips off once they know the knobs.
 */
import { GRAPHICS_HELP_LINES } from './graphicsHelpCopy';

const KEY = 'idleCraft.graphicsHelpEnabled';

export function getGraphicsHelpEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

export function setGraphicsHelpEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * Injects or removes one-line tips under elements marked with `data-help-id`.
 */
export function applyGraphicsHelpLines(menuRoot: HTMLElement): void {
  const on = getGraphicsHelpEnabled();
  menuRoot.querySelectorAll('[data-help-id]').forEach((host) => {
    const id = host.getAttribute('data-help-id');
    const text = id ? GRAPHICS_HELP_LINES[id] : undefined;
    const tip = host.querySelector(':scope > .system-menu__graph-tip');
    if (!on || !text) {
      tip?.remove();
      return;
    }
    let p = tip as HTMLParagraphElement | null;
    if (!p) {
      p = document.createElement('p');
      p.className = 'system-menu__graph-tip';
      host.appendChild(p);
    }
    p.textContent = text;
  });
}
