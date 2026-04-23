/**
 * "Press anywhere to begin" splash. Sole job: capture a user gesture so the
 * cutscene that follows can autoplay with audio (modern browser policy).
 *
 * Resolves on the first click / key press; caller is responsible for
 * everything that happens after (cutscene, preload, etc).
 */
import './introSplash.css';

export function presentIntroSplash(parent: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const root = document.createElement('div');
    root.className = 'intro-splash-root';
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', 'Press anywhere to begin');
    root.tabIndex = 0;

    const brand = document.createElement('div');
    brand.className = 'intro-splash-brand';
    brand.textContent = 'MOBA';

    const title = document.createElement('div');
    title.className = 'intro-splash-title';
    title.textContent = 'THE CURSE';

    const cta = document.createElement('div');
    cta.className = 'intro-splash-cta';
    cta.textContent = '▶ press anywhere to begin';

    root.append(brand, title, cta);
    parent.appendChild(root);

    let dismissed = false;
    let onKey: ((e: KeyboardEvent) => void) | null = null;

    const dismiss = (): void => {
      if (dismissed) return;
      dismissed = true;
      root.classList.remove('is-visible');
      root.classList.add('is-leaving');
      if (onKey) {
        window.removeEventListener('keydown', onKey);
        onKey = null;
      }
      /* 400 ms → 160 ms: the player just clicked, they want the next thing
       * to happen NOW. Cutscene fades in while splash fades out — overlap
       * makes the transition feel snappy without hiding the visual handoff. */
      window.setTimeout(() => {
        root.remove();
        resolve();
      }, 160);
    };

    root.addEventListener('click', dismiss);
    onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);

    requestAnimationFrame(() => {
      root.classList.add('is-visible');
      root.focus({ preventScroll: true });
    });
  });
}
