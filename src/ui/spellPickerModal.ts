/**
 * Awakened-mode spell picker modal.
 *
 * Lists every UNLOCKED spell card from `cardDefs` filtered by `kind`:
 *   - `'offense'` — cards with `attackStyle: 'spell'` AND positive `damage`.
 *   - `'defense'` — cards with `attackStyle: 'spell'` AND positive `wardFlat`.
 *
 * Player clicks a card to equip it; a "(Unequip)" row clears the slot. Modal closes
 * on Esc, backdrop click, or after a successful equip. Built fresh each call so the
 * card list is always live (no stale unlock state).
 *
 * Designed for click from the awakened hotbar's offensive / defensive spell slots —
 * see `awakenedHotbar.ts`. Self-contained module; no global state, no scene mutations.
 */
import type { GameStore } from '../core/gameStore';
import { allCards } from '../core/gameStore';
import type { CardDef } from '../core/types';

export type SpellSlotKind = 'offense' | 'defense';

interface OpenOpts {
  /** `'offense'` lists damage spells; `'defense'` lists ward spells. */
  kind: SpellSlotKind;
  /** Game shell element — modal mounts as a child so its z-index sits above the hotbar. */
  host: HTMLElement;
  store: GameStore;
}

/** Inject the modal styles once per session. CSS-in-JS keeps the module self-contained. */
let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .spell-picker-backdrop {
      /* Fixed-position with a z-index above the awakened-menu overlay
       * (.awakened-menu-overlay = z-index 9100). The previous absolute
       * positioning meant this backdrop was stuck in the shell's stacking
       * context, so when the player clicked an empty spell slot from the
       * inventory menu (Tab → Inventory), this picker rendered UNDERNEATH
       * the inventory overlay and the player had to close the menu first.
       * Fixed + z-index 9300 lets the picker float above ANY open page
       * overlay. */
      position: fixed; inset: 0;
      background: rgba(8, 12, 22, 0.78);
      backdrop-filter: blur(6px);
      z-index: 9300;
      display: flex; align-items: center; justify-content: center;
      animation: spell-picker-fade 0.15s ease-out;
    }
    .spell-picker-panel {
      background: linear-gradient(165deg, #16203a 0%, #0d162a 100%);
      border: 1px solid #66e0ff55;
      border-radius: 14px;
      padding: 22px 26px;
      max-width: 580px;
      width: calc(100% - 64px);
      max-height: 78vh;
      overflow-y: auto;
      color: #e6f3ff;
      box-shadow: 0 0 30px rgba(102, 224, 255, 0.18), 0 12px 40px rgba(0,0,0,0.55);
      font-family: system-ui, sans-serif;
    }
    .spell-picker-title {
      font-size: 1.35rem; font-weight: 700; margin: 0 0 4px 0;
      color: #66e0ff; letter-spacing: 0.04em;
    }
    .spell-picker-sub {
      font-size: 0.85rem; opacity: 0.7; margin: 0 0 16px 0;
    }
    .spell-picker-list {
      display: flex; flex-direction: column; gap: 8px;
    }
    .spell-picker-card {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s, transform 0.08s;
      text-align: left;
      width: 100%;
      color: inherit;
      font: inherit;
    }
    .spell-picker-card:hover {
      background: rgba(102,224,255,0.08);
      border-color: #66e0ff77;
      transform: translateX(2px);
    }
    .spell-picker-card--equipped {
      background: rgba(102,224,255,0.14);
      border-color: #66e0ff;
    }
    .spell-picker-card-glyph {
      font-size: 1.6rem; line-height: 1;
      width: 32px; text-align: center;
      color: #66e0ff;
    }
    .spell-picker-card--defense .spell-picker-card-glyph { color: #ff7afe; }
    .spell-picker-card-body { flex: 1; min-width: 0; }
    .spell-picker-card-name {
      font-weight: 600; font-size: 1rem;
      display: flex; align-items: center; gap: 8px;
    }
    .spell-picker-card-equipped-pill {
      font-size: 0.7rem; padding: 2px 8px;
      border-radius: 999px; background: #66e0ff; color: #0d162a;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    .spell-picker-card-meta {
      font-size: 0.78rem; opacity: 0.75; margin-top: 2px;
    }
    .spell-picker-card-desc {
      font-size: 0.78rem; opacity: 0.6; margin-top: 4px;
      line-height: 1.35;
    }
    .spell-picker-card--unequip { opacity: 0.7; font-style: italic; }
    .spell-picker-empty {
      padding: 20px; text-align: center; opacity: 0.65; font-size: 0.95rem;
    }
    .spell-picker-close {
      position: absolute; top: 14px; right: 18px;
      background: none; border: none; color: #66e0ff; opacity: 0.7;
      font-size: 1.4rem; cursor: pointer; padding: 4px 10px;
      transition: opacity 0.12s;
    }
    .spell-picker-close:hover { opacity: 1; }
    @keyframes spell-picker-fade { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);
}

/**
 * Filter the master `allCards` list down to spells matching `kind`. Falls back to
 * empty list if no unlocks qualify (the modal then shows a friendly empty state
 * pointing the player at the magic deck unlock path).
 */
function listEligible(kind: SpellSlotKind, unlockedIds: ReadonlySet<string>): CardDef[] {
  return allCards.filter((c) => {
    if (!unlockedIds.has(c.id)) return false;
    if (c.battle?.attackStyle !== 'spell') return false;
    if (kind === 'offense') return typeof c.battle.damage === 'number' && c.battle.damage > 0;
    return typeof c.battle.wardFlat === 'number' && c.battle.wardFlat > 0;
  });
}

export function openSpellPickerModal(opts: OpenOpts): void {
  injectStyles();

  const state = opts.store.getState();
  const unlocked = new Set(state.unlockedCardIds);
  const eligible = listEligible(opts.kind, unlocked);
  const equippedId = opts.kind === 'offense'
    ? state.equippedOffensiveSpellId
    : state.equippedDefensiveSpellId;

  const backdrop = document.createElement('div');
  backdrop.className = 'spell-picker-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const titleText = opts.kind === 'offense' ? 'Equip offensive spell' : 'Equip defensive spell';
  const subText = opts.kind === 'offense'
    ? 'Cast with LMB while a wand or staff is equipped. Damage + mana cost are pulled from the spell card.'
    : 'Activate the magical ward bubble (RMB hold) to drain mana and absorb incoming damage.';

  const panel = document.createElement('div');
  panel.className = 'spell-picker-panel';
  panel.style.position = 'relative';
  panel.innerHTML = `
    <button type="button" class="spell-picker-close" aria-label="Close">×</button>
    <h2 class="spell-picker-title">${titleText}</h2>
    <p class="spell-picker-sub">${subText}</p>
    <div class="spell-picker-list" data-spell-list></div>
  `;
  backdrop.appendChild(panel);

  const list = panel.querySelector<HTMLElement>('[data-spell-list]')!;
  const glyph = opts.kind === 'offense' ? '✦' : '◈';

  if (eligible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'spell-picker-empty';
    empty.textContent = opts.kind === 'offense'
      ? 'No offensive spells unlocked yet. Craft one from the magic tree (e.g. "Ember bolt" via the Magic Awakening card).'
      : 'No defensive spells unlocked yet. Craft "Glancing ward" or "Aegis ring" from the magic tree.';
    list.appendChild(empty);
  } else {
    /* Unequip row first — quick way to clear the slot. */
    const unequipBtn = document.createElement('button');
    unequipBtn.type = 'button';
    unequipBtn.className = 'spell-picker-card spell-picker-card--unequip';
    unequipBtn.innerHTML = `
      <div class="spell-picker-card-glyph">·</div>
      <div class="spell-picker-card-body">
        <div class="spell-picker-card-name">— Empty slot —</div>
        <div class="spell-picker-card-desc">No spell equipped in this slot.</div>
      </div>
    `;
    unequipBtn.addEventListener('click', () => {
      if (opts.kind === 'offense') opts.store.equipOffensiveSpell(null);
      else opts.store.equipDefensiveSpell(null);
      close();
    });
    list.appendChild(unequipBtn);

    for (const card of eligible) {
      const isEquipped = card.id === equippedId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `spell-picker-card spell-picker-card--${opts.kind}${isEquipped ? ' spell-picker-card--equipped' : ''}`;
      const power = opts.kind === 'offense'
        ? `${card.battle?.damage ?? 0} dmg`
        : `${card.battle?.wardFlat ?? 0} ward`;
      const cost = card.battle?.manaCost ?? 0;
      btn.innerHTML = `
        <div class="spell-picker-card-glyph">${glyph}</div>
        <div class="spell-picker-card-body">
          <div class="spell-picker-card-name">
            ${card.name}
            ${isEquipped ? '<span class="spell-picker-card-equipped-pill">Equipped</span>' : ''}
          </div>
          <div class="spell-picker-card-meta">${power} · ${cost} mana · tier ${card.tier}</div>
          <div class="spell-picker-card-desc">${card.description}</div>
        </div>
      `;
      btn.addEventListener('click', () => {
        if (opts.kind === 'offense') opts.store.equipOffensiveSpell(card.id);
        else opts.store.equipDefensiveSpell(card.id);
        close();
      });
      list.appendChild(btn);
    }
  }

  function close(): void {
    document.removeEventListener('keydown', onKey, true);
    if (backdrop.parentElement) backdrop.parentElement.removeChild(backdrop);
  }
  /* Backdrop click closes (but not panel-internal clicks). */
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  panel.querySelector<HTMLButtonElement>('.spell-picker-close')!.addEventListener('click', close);

  /* Capture-phase Esc handler so we beat the system menu's global listener. */
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  opts.host.appendChild(backdrop);
}
