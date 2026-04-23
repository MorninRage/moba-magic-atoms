/**
 * Reusable shortcut bar — the two equipped-magic slots (Offensive + Defensive) that
 * the player wants to see EVERYWHERE the equipment is relevant: the awakened-mode
 * hotbar (already wired in `awakenedHotbar.ts`), the Inventory tab, AND the Decks
 * tab. Click on a slot opens `spellPickerModal` to swap the equipped card.
 *
 * **Why a separate module from `awakenedHotbar.ts`:** the hotbar is a fullscreen
 * bottom-of-screen overlay that ALSO carries vital bars / equipment tools / inventory
 * strip. The spell slots are one chunk of that overlay. The Inventory + Decks pages
 * want JUST the spell slots, not the whole hotbar (those pages have their own layout
 * and existing equipment widgets). Extracting the slots into this module gives both
 * surfaces a single source of truth.
 *
 * **Mount lifecycle:** `mountShortcutBar(host, store)` builds the DOM into `host`,
 * subscribes to the store, and returns a `dispose()` that tears down both. Idempotent
 * to call multiple times (each call returns its own handle with its own subscription).
 *
 * **Passive-card note:** Cards without a `battle` field (just `maxManaBonus`,
 * `manaRegenBonus`, `automation`, etc.) are PASSIVE — they auto-apply when unlocked
 * and don't take a shortcut slot. The picker filters those out by checking
 * `attackStyle === 'spell'`. Passive cards stay deck-mode-only.
 */
import type { GameStore } from '../core/gameStore';
import { allCards } from '../core/gameStore';
import { openSpellPickerModal } from './spellPickerModal';

const SPELL_GLYPH = '✦';
const SPELL_DEF_GLYPH = '◈';

export interface ShortcutBarHandle {
  /** Tear down DOM + unsubscribe from the store. */
  dispose(): void;
}

interface MountOpts {
  /**
   * Host element where the spell-picker modal mounts on click. Different from the
   * shortcut-bar `parent` because the picker uses absolute positioning relative to
   * the game shell — it should sit ABOVE the page (z-index 95) regardless of which
   * tab is showing the bar. Pass the same shell element used for `mountAwakenedHotbar`.
   */
  modalHost: HTMLElement;
  /**
   * Optional helper text shown above the slots. Inventory + Decks pages set this to
   * orient the player ("These are your two awakened-mode magic shortcuts..."), the
   * awakened hotbar sets it to null because the slots speak for themselves at the
   * bottom of the screen.
   */
  helperText?: string;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .shortcut-bar {
      display: flex; flex-direction: column; gap: 6px;
      margin: 12px 0 18px 0;
    }
    .shortcut-bar__helper {
      font-size: 0.78rem; color: var(--muted, #94a3b8);
      margin: 0; line-height: 1.4;
    }
    .shortcut-bar__slots {
      display: flex; gap: 10px; flex-wrap: wrap;
    }
    .shortcut-bar__slot {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s, transform 0.08s;
      font: inherit; color: inherit;
      min-width: 220px;
      text-align: left;
    }
    .shortcut-bar__slot:hover {
      background: rgba(102,224,255,0.10);
      border-color: #66e0ff77;
      transform: translateY(-1px);
    }
    .shortcut-bar__slot--equipped {
      background: rgba(102,224,255,0.12);
      border-color: #66e0ff;
    }
    .shortcut-bar__slot--defense.shortcut-bar__slot--equipped {
      background: rgba(255,122,254,0.12);
      border-color: #ff7afe;
    }
    .shortcut-bar__slot-glyph {
      font-size: 1.4rem; line-height: 1;
      width: 28px; text-align: center; color: #66e0ff;
    }
    .shortcut-bar__slot--defense .shortcut-bar__slot-glyph { color: #ff7afe; }
    .shortcut-bar__slot-body { flex: 1; min-width: 0; }
    .shortcut-bar__slot-label {
      font-size: 0.72rem; color: var(--muted, #94a3b8);
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .shortcut-bar__slot-name {
      font-size: 0.95rem; font-weight: 600; margin-top: 1px;
    }
    .shortcut-bar__slot-meta {
      font-size: 0.7rem; color: var(--muted, #94a3b8); margin-top: 2px;
    }
    /* Combat-mode toggle pill — sits between / after the slots; only shown when
     * an offensive spell is equipped (otherwise the toggle has nothing to gate). */
    .shortcut-bar__mode-toggle {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      cursor: pointer; font: inherit; color: inherit;
      align-self: center;
      transition: background 0.12s, border-color 0.12s;
    }
    .shortcut-bar__mode-toggle:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.22);
    }
    .shortcut-bar__mode-toggle--magic {
      border-color: #66e0ff77;
      background: rgba(102,224,255,0.10);
    }
    .shortcut-bar__mode-toggle--hit {
      border-color: #ffb86877;
      background: rgba(255,184,104,0.10);
    }
    .shortcut-bar__mode-toggle-label {
      font-size: 0.7rem; color: var(--muted, #94a3b8);
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .shortcut-bar__mode-toggle-value {
      font-size: 0.9rem; font-weight: 600;
    }
    .shortcut-bar__mode-toggle--magic .shortcut-bar__mode-toggle-value { color: #66e0ff; }
    .shortcut-bar__mode-toggle--hit .shortcut-bar__mode-toggle-value { color: #ffb868; }
    .shortcut-bar__mode-toggle-key {
      font-size: 0.65rem; opacity: 0.55;
      padding: 1px 6px; border: 1px solid currentColor; border-radius: 4px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Render the two shortcut slot buttons into the given container element. Pure render
 * (no event listeners, no store subscription) — `mountShortcutBar` wires those.
 */
function renderSlots(
  container: HTMLElement,
  state: ReturnType<GameStore['getState']>,
): void {
  const offCard = state.equippedOffensiveSpellId
    ? allCards.find((c) => c.id === state.equippedOffensiveSpellId)
    : null;
  const defCard = state.equippedDefensiveSpellId
    ? allCards.find((c) => c.id === state.equippedDefensiveSpellId)
    : null;

  function slot(
    pickerKey: 'offense' | 'defense',
    label: string,
    glyph: string,
    cardName: string | null,
    metaParts: string[],
  ): string {
    const empty = !cardName;
    const klass = `shortcut-bar__slot shortcut-bar__slot--${pickerKey}${empty ? '' : ' shortcut-bar__slot--equipped'}`;
    const meta = !empty && metaParts.length > 0
      ? `<div class="shortcut-bar__slot-meta">${metaParts.join(' · ')}</div>`
      : '';
    return `
      <button type="button" class="${klass}" data-shortcut-pick="${pickerKey}">
        <div class="shortcut-bar__slot-glyph">${glyph}</div>
        <div class="shortcut-bar__slot-body">
          <div class="shortcut-bar__slot-label">${label}</div>
          <div class="shortcut-bar__slot-name">${empty ? 'Click to equip' : cardName}</div>
          ${meta}
        </div>
      </button>
    `;
  }

  const offMeta: string[] = [];
  if (offCard?.battle) {
    if (typeof offCard.battle.damage === 'number') offMeta.push(`${offCard.battle.damage} dmg`);
    if (typeof offCard.battle.manaCost === 'number') offMeta.push(`${offCard.battle.manaCost} mana`);
  }
  const defMeta: string[] = [];
  if (defCard?.battle) {
    if (typeof defCard.battle.wardFlat === 'number') defMeta.push(`${defCard.battle.wardFlat} ward`);
    defMeta.push('3 mana/sec while held');
  }

  /* Combat-mode toggle — only shown when an offensive spell is equipped. The
   * toggle's own internal data attribute drives the click delegation in the
   * mount function, so it's pure markup here. The button reads the live
   * `combatMode` for label + style so it always matches store state. */
  let modeToggleHtml = '';
  if (offCard) {
    const mode = state.combatMode;
    const label = mode === 'magic' ? 'Magic + melee' : 'Hit only';
    modeToggleHtml = `
      <button type="button"
        class="shortcut-bar__mode-toggle shortcut-bar__mode-toggle--${mode}"
        data-shortcut-mode-toggle
        title="${mode === 'magic'
          ? 'LMB casts the equipped offensive spell AND swings melee at close range. Press M or click to switch to hit-only mode.'
          : 'LMB swings melee only — equipped spell stays slotted but does not fire. Press M or click to switch to magic mode.'}">
        <span class="shortcut-bar__mode-toggle-label">LMB mode</span>
        <span class="shortcut-bar__mode-toggle-value">${label}</span>
        <span class="shortcut-bar__mode-toggle-key">M</span>
      </button>
    `;
  }

  container.innerHTML = `
    ${slot('offense', 'Offensive spell (LMB cast)', SPELL_GLYPH, offCard?.name ?? null, offMeta)}
    ${slot('defense', 'Defensive ward (RMB hold)', SPELL_DEF_GLYPH, defCard?.name ?? null, defMeta)}
    ${modeToggleHtml}
  `;
}

export function mountShortcutBar(
  parent: HTMLElement,
  store: GameStore,
  opts: MountOpts,
): ShortcutBarHandle {
  injectStyles();

  const root = document.createElement('div');
  root.className = 'shortcut-bar';
  if (opts.helperText) {
    const helper = document.createElement('p');
    helper.className = 'shortcut-bar__helper';
    helper.textContent = opts.helperText;
    root.appendChild(helper);
  }
  const slotsEl = document.createElement('div');
  slotsEl.className = 'shortcut-bar__slots';
  root.appendChild(slotsEl);
  parent.appendChild(root);

  /* Click delegation: opens the spell picker for the matching slot kind, OR
   * flips combat mode if the toggle pill was clicked. Single delegated listener
   * keeps the per-mount cost flat regardless of how many controls are inside. */
  slotsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const slotEl = target.closest<HTMLElement>('[data-shortcut-pick]');
    if (slotEl) {
      const kind = slotEl.dataset.shortcutPick as 'offense' | 'defense' | undefined;
      if (kind === 'offense' || kind === 'defense') {
        openSpellPickerModal({ kind, host: opts.modalHost, store });
      }
      return;
    }
    if (target.closest<HTMLElement>('[data-shortcut-mode-toggle]')) {
      store.toggleCombatMode();
    }
  });

  /* Sig-gated re-render — redraw on equipped-spell, unlock, OR combat-mode change. */
  let lastSig = '';
  function refresh(): void {
    const s = store.getState();
    const sig = `${s.equippedOffensiveSpellId ?? ''}|${s.equippedDefensiveSpellId ?? ''}|${s.combatMode}|${s.unlockedCardIds.join(',')}`;
    if (sig === lastSig) return;
    lastSig = sig;
    renderSlots(slotsEl, s);
  }
  refresh();
  const unsub = store.subscribe(refresh);

  return {
    dispose(): void {
      unsub();
      if (root.parentElement) root.parentElement.removeChild(root);
    },
  };
}
