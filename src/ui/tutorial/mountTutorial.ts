import type { GameStore } from '../../core/gameStore';
import { applyGraphicsHelpLines, setGraphicsHelpEnabled } from '../graphicsHelpSettings';
import { openCampSystemMenu } from '../systemMenuStub';
import './tutorial.css';
import { TUTORIAL_COPY } from './tutorialCopy';

const WINDFALL_CARD_ID = 'c_idle_windfall';

export type TutorialPage =
  | 'gather'
  | 'craft'
  | 'inventory'
  | 'decks'
  | 'idle'
  | 'rpg'
  | 'battle'
  | 'hire'
  | 'awakening'
  | 'portal';

type TutorialCtx = {
  appRoot: HTMLElement;
  store: GameStore;
  getPage: () => TutorialPage;
  setPage: (p: TutorialPage) => void;
  isOnlinePvpNavLocked: () => boolean;
};

const STEP_SEQUENCE: string[] = [
  'hud_meters',
  'nav_tabs',
  'gather_water',
  'gather_berries',
  'idle_tab',
  'idle_windfall',
  'decks_tab',
  'craft_tab',
  'inventory_tab',
  'battle_tab',
  'hire_tab',
  'rpg_tab',
  'gather_merchant',
  'gather_again',
  'portal_tab',
  'esc_camera',
  'esc_graphics',
];

const STEP_PAGE: Record<string, TutorialPage | null> = {
  hud_meters: null,
  nav_tabs: null,
  gather_water: 'gather',
  gather_berries: 'gather',
  idle_tab: 'idle',
  idle_windfall: 'idle',
  decks_tab: 'decks',
  craft_tab: 'craft',
  inventory_tab: 'inventory',
  battle_tab: 'battle',
  battle_combat_tip: 'battle',
  hire_tab: 'hire',
  gather_again: 'gather',
  /** Do not switch away from the current tab; spotlight the Portal nav control only. */
  portal_tab: null,
  esc_camera: null,
  esc_graphics: null,
};

const STEP_ANCHOR: Record<string, string | null> = {
  hud_meters: '#app-hud',
  nav_tabs: 'nav.nav',
  gather_water: '[data-tutorial-gather="water"]',
  gather_berries: '[data-tutorial-gather="berries"]',
  idle_tab: '[data-nav-page="idle"]',
  idle_windfall: '[data-tutorial-windfall]',
  decks_tab: '[data-tutorial-decks-anchor]',
  craft_tab: '[data-tutorial-craft-anchor]',
  inventory_tab: '[data-tutorial-inventory-anchor]',
  battle_tab: '[data-tutorial-battle-lobby]',
  battle_combat_tip: '[data-tutorial-battle-combat]',
  hire_tab: '[data-tutorial-hire-anchor]',
  rpg_tab: '[data-tutorial-rpg-anchor]',
  gather_merchant: '[data-tutorial-merchant]',
  gather_again: '[data-tutorial-gather-layout]',
  portal_tab: '[data-nav-page="portal"]',
  esc_camera: '#character-dock',
  esc_graphics: '[data-system-graphics-pp]',
};

let active: TutorialRunner | null = null;

export function mountTutorial(ctx: TutorialCtx): void {
  active?.destroy();
  const t = ctx.store.getTutorial();
  if (t.status === 'skipped' || t.status === 'completed') {
    active = null;
    return;
  }
  active = new TutorialRunner(ctx);
  active.mount();
}

export function syncTutorialAfterRender(): void {
  active?.sync();
}

export function destroyTutorial(): void {
  active?.destroy();
  active = null;
}

class TutorialRunner {
  private readonly ctx: TutorialCtx;
  private root: HTMLDivElement | null = null;
  private scrim: HTMLDivElement | null = null;
  private spotlight: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;
  private introEl: HTMLDivElement | null = null;
  private unsub: (() => void) | null = null;
  private lastStepId = '';

  constructor(ctx: TutorialCtx) {
    this.ctx = ctx;
  }

  mount(): void {
    const t = this.ctx.store.getTutorial();

    this.root = document.createElement('div');
    this.root.className = 'tutorial-root tutorial-root--interactive';
    this.root.setAttribute('aria-live', 'polite');

    this.scrim = document.createElement('div');
    this.scrim.className = 'tutorial-scrim';
    this.root.appendChild(this.scrim);

    this.spotlight = document.createElement('div');
    this.spotlight.className = 'tutorial-spotlight tutorial-spotlight--hidden';
    this.root.appendChild(this.spotlight);

    this.card = document.createElement('div');
    this.card.className = 'tutorial-card';
    this.card.style.display = 'none';
    this.root.appendChild(this.card);

    this.ctx.appRoot.appendChild(this.root);

    this.unsub = this.ctx.store.subscribe(() => this.onStore());

    if (t.status === 'not_started') {
      this.showIntro();
    } else if (t.status === 'active') {
      this.lastStepId = t.stepId;
      this.showStepCard(t.stepId);
      this.sync();
    }
  }

  private onStore(): void {
    const t = this.ctx.store.getTutorial();
    if (t.status !== 'active') return;

    if (t.stepId !== this.lastStepId) {
      this.lastStepId = t.stepId;
      if (!this.introEl) {
        this.showStepCard(t.stepId);
      }
    }

    if (t.stepId === 'idle_windfall') {
      const slots = this.ctx.store.getState().idleSlots;
      const allWindfall =
        slots.length > 0 && slots.every((c) => c === WINDFALL_CARD_ID);
      if (allWindfall) {
        this.ctx.store.tutorialSetStep('decks_tab');
        return;
      }
    }

    if (t.stepId === 'battle_tab' && this.ctx.store.getState().battle) {
      if (!t.flags?.battleCombatHintShown) {
        this.ctx.store.tutorialSetStep('battle_combat_tip');
        return;
      }
    }

    if (t.stepId === 'battle_combat_tip' && !this.ctx.store.getState().battle) {
      this.ctx.store.tutorialSetStep('hire_tab');
      return;
    }

    this.sync();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.root?.remove();
    this.root = null;
    this.scrim = null;
    this.spotlight = null;
    this.card = null;
    this.introEl = null;
  }

  private showIntro(): void {
    if (!this.root) return;
    this.introEl?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-card tutorial-intro';
    const copy = TUTORIAL_COPY.intro!;
    wrap.innerHTML = `
      <h2>${escapeHtml(copy.title)}</h2>
      <p>${escapeHtml(copy.body)}</p>
      <div class="tutorial-card__actions">
        <button type="button" class="tutorial-btn-ghost" data-tut-skip>Skip</button>
        <button type="button" class="tutorial-btn-primary" data-tut-guided>Guided tour</button>
      </div>`;
    wrap.querySelector('[data-tut-skip]')?.addEventListener('click', () => {
      this.ctx.store.tutorialSkip();
      destroyTutorial();
    });
    wrap.querySelector('[data-tut-guided]')?.addEventListener('click', () => {
      wrap.remove();
      this.introEl = null;
      this.ctx.store.tutorialStartGuided();
      this.lastStepId = 'hud_meters';
      this.showStepCard('hud_meters');
      this.sync();
    });
    this.root.appendChild(wrap);
    this.introEl = wrap;
    if (this.spotlight) this.spotlight.classList.add('tutorial-spotlight--hidden');
    if (this.card) this.card.style.display = 'none';
  }

  private showStepCard(stepId: string): void {
    if (!this.card || !this.root) return;
    const copy = TUTORIAL_COPY[stepId];
    if (!copy) return;

    const isLast = stepId === 'esc_graphics';
    this.card.style.display = 'block';
    this.card.innerHTML = `
      <h2>${escapeHtml(copy.title)}</h2>
      <p>${escapeHtml(copy.body)}</p>
      <div class="tutorial-card__actions">
        <button type="button" class="tutorial-btn-ghost" data-tut-skip-all>Skip tutorial</button>
        <button type="button" class="tutorial-btn-primary" data-tut-next>${isLast ? 'Finish' : 'Continue'}</button>
      </div>`;

    this.card.querySelector('[data-tut-skip-all]')?.addEventListener('click', () => {
      this.ctx.store.tutorialSkip();
      destroyTutorial();
    });

    this.card.querySelector('[data-tut-next]')?.addEventListener('click', () => {
      this.advance(stepId);
    });

    if (stepId === 'esc_graphics') {
      setGraphicsHelpEnabled(true);
      openCampSystemMenu({ focusGraphics: true });
      const shell = document.getElementById('system-menu-overlay');
      if (shell) applyGraphicsHelpLines(shell);
      requestAnimationFrame(() => requestAnimationFrame(() => this.sync()));
    }

    this.positionCardNearAnchor(stepId);
  }

  private advance(current: string): void {
    if (current === 'esc_graphics') {
      this.ctx.store.tutorialComplete();
      destroyTutorial();
      return;
    }

    if (current === 'battle_tab') {
      if (this.ctx.store.getState().battle) {
        this.ctx.store.tutorialSetStep('battle_combat_tip');
        return;
      }
      this.ctx.store.tutorialSetStep('hire_tab');
      this.ensurePageForStep('hire_tab');
      return;
    }

    if (current === 'battle_combat_tip') {
      this.ctx.store.tutorialMarkBattleCombatHintShown();
      this.ctx.store.tutorialSetStep('hire_tab');
      this.ensurePageForStep('hire_tab');
      return;
    }

    const ix = STEP_SEQUENCE.indexOf(current);
    if (ix < 0 || ix >= STEP_SEQUENCE.length - 1) {
      this.ctx.store.tutorialComplete();
      destroyTutorial();
      return;
    }
    const next = STEP_SEQUENCE[ix + 1]!;
    this.ctx.store.tutorialSetStep(next);
    this.ensurePageForStep(next);
  }

  private ensurePageForStep(stepId: string): void {
    if (this.ctx.isOnlinePvpNavLocked()) return;
    const p = STEP_PAGE[stepId];
    if (p != null && this.ctx.getPage() !== p) {
      this.ctx.setPage(p);
    }
  }

  sync(): void {
    if (!this.root || !this.spotlight || !this.card) return;
    const t = this.ctx.store.getTutorial();
    if (t.status !== 'active' && t.status !== 'not_started') {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    if (t.status === 'not_started' || this.introEl) return;

    const stepId = t.stepId;
    this.ensurePageForStep(stepId);
    this.positionCardNearAnchor(stepId);
    this.positionSpotlight(stepId);
  }

  private positionSpotlight(stepId: string): void {
    if (!this.spotlight) return;
    const sel = STEP_ANCHOR[stepId];
    if (!sel) {
      this.spotlight.classList.add('tutorial-spotlight--hidden');
      return;
    }
    const el = document.querySelector(sel);
    if (!el || !(el instanceof HTMLElement)) {
      this.spotlight.classList.add('tutorial-spotlight--hidden');
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    this.spotlight.classList.remove('tutorial-spotlight--hidden');
    this.spotlight.classList.add('tutorial-target-pulse');
    Object.assign(this.spotlight.style, {
      top: `${r.top + window.scrollY - pad}px`,
      left: `${r.left + window.scrollX - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
  }

  private positionCardNearAnchor(stepId: string): void {
    if (!this.card) return;
    const sel = STEP_ANCHOR[stepId];
    if (!sel) {
      this.card.style.left = '50%';
      this.card.style.top = '50%';
      this.card.style.transform = 'translate(-50%, -50%)';
      this.card.style.right = 'auto';
      this.card.style.bottom = 'auto';
      return;
    }
    const el = document.querySelector(sel);
    const margin = 12;
    if (!el || !(el instanceof HTMLElement)) {
      this.card.style.left = '50%';
      this.card.style.top = '50%';
      this.card.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const r = el.getBoundingClientRect();
    const cw = this.card.offsetWidth || 320;
    const ch = this.card.offsetHeight || 200;
    let left = r.right + margin;
    if (left + cw > window.innerWidth - margin) {
      left = r.left - cw - margin;
    }
    if (left < margin) left = margin;
    let top = r.top;
    if (top + ch > window.innerHeight - margin) {
      top = window.innerHeight - ch - margin;
    }
    if (top < margin) top = margin;
    this.card.style.transform = 'none';
    this.card.style.left = `${left + window.scrollX}px`;
    this.card.style.top = `${top + window.scrollY}px`;
    this.card.style.right = 'auto';
    this.card.style.bottom = 'auto';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
