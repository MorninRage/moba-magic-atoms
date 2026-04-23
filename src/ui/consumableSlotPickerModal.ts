/**
 * Awakened-mode consumable slot picker modal.
 *
 * Opens when the player clicks an empty (or filled) consumable hotbar slot. Lists
 * every consumable id from `CONSUMABLE_ITEM_IDS` plus the live inventory count so
 * the player can pick what to assign. Items with zero inventory are still listed
 * (greyed out) — assignment is allowed (the slot is reserved for when the player
 * picks/crafts the item later) but visibly empty.
 *
 * Mirrors the spell picker's UX so the two pickers feel like the same system from
 * the player's POV. Closes on Esc, backdrop click, or after a successful assign.
 */
import type { GameStore } from '../core/gameStore';
import { CONSUMABLE_ITEM_IDS, CONSUMABLE_META, type ConsumableItemId } from '../data/consumables';

interface OpenOpts {
  /** 0-indexed hotbar slot (0..5). */
  slotIdx: number;
  host: HTMLElement;
  store: GameStore;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .consumable-picker-backdrop {
      /* Fixed-position with a z-index above the awakened-menu overlay
       * (.awakened-menu-overlay = z-index 9100). The previous absolute
       * positioning meant this backdrop was stuck in the shell's stacking
       * context, so clicking an empty consumable slot while the inventory
       * menu was open rendered the picker BENEATH the inventory and the
       * player had to close the menu first. Fixed + z-index 9300 lets
       * the picker float above ANY open page overlay. */
      position: fixed; inset: 0;
      background: rgba(8, 12, 22, 0.78);
      backdrop-filter: blur(6px);
      z-index: 9300;
      display: flex; align-items: center; justify-content: center;
      animation: consumable-picker-fade 0.15s ease-out;
    }
    .consumable-picker-panel {
      background: linear-gradient(165deg, #16203a 0%, #0d162a 100%);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      padding: 22px 26px;
      max-width: 540px;
      width: calc(100% - 64px);
      max-height: 78vh;
      overflow-y: auto;
      color: #e6f3ff;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55);
      font-family: system-ui, sans-serif;
      position: relative;
    }
    .consumable-picker-title {
      font-size: 1.3rem; font-weight: 700; margin: 0 0 4px 0;
      color: #ffd2b3; letter-spacing: 0.04em;
    }
    .consumable-picker-sub {
      font-size: 0.85rem; opacity: 0.7; margin: 0 0 14px 0;
    }
    .consumable-picker-list {
      display: flex; flex-direction: column; gap: 8px;
    }
    .consumable-picker-card {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s, transform 0.08s;
      width: 100%; text-align: left;
      color: inherit; font: inherit;
    }
    .consumable-picker-card:hover {
      background: rgba(255,255,255,0.08);
      transform: translateX(2px);
    }
    .consumable-picker-card--equipped {
      background: rgba(255,210,179,0.12);
      border-color: #ffd2b3;
    }
    .consumable-picker-card--zero { opacity: 0.55; }
    .consumable-picker-card-glyph {
      font-size: 1.6rem; line-height: 1;
      width: 32px; text-align: center;
    }
    .consumable-picker-card-body { flex: 1; min-width: 0; }
    .consumable-picker-card-name {
      font-weight: 600; font-size: 1rem;
      display: flex; align-items: center; gap: 8px;
    }
    .consumable-picker-card-count {
      font-size: 0.78rem; opacity: 0.8; margin-top: 2px;
    }
    .consumable-picker-card-desc {
      font-size: 0.78rem; opacity: 0.6; margin-top: 4px;
      line-height: 1.35;
    }
    .consumable-picker-card-equipped-pill {
      font-size: 0.7rem; padding: 2px 8px; border-radius: 999px;
      background: #ffd2b3; color: #2a1c10;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    .consumable-picker-card--unequip { font-style: italic; opacity: 0.7; }
    .consumable-picker-close {
      position: absolute; top: 14px; right: 18px;
      background: none; border: none; color: #ffd2b3; opacity: 0.7;
      font-size: 1.4rem; cursor: pointer; padding: 4px 10px;
    }
    .consumable-picker-close:hover { opacity: 1; }
    @keyframes consumable-picker-fade { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);
}

export function openConsumableSlotPickerModal(opts: OpenOpts): void {
  injectStyles();

  const state = opts.store.getState();
  const currentItem = state.hotbarSlots[opts.slotIdx];
  const slotKeyLabel = String(opts.slotIdx + 1);

  const backdrop = document.createElement('div');
  backdrop.className = 'consumable-picker-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const panel = document.createElement('div');
  panel.className = 'consumable-picker-panel';
  panel.innerHTML = `
    <button type="button" class="consumable-picker-close" aria-label="Close">×</button>
    <h2 class="consumable-picker-title">Assign to slot ${slotKeyLabel}</h2>
    <p class="consumable-picker-sub">Press the matching number key (or click the slot in awakened mode) to consume one of this item.</p>
    <div class="consumable-picker-list" data-list></div>
  `;
  backdrop.appendChild(panel);

  const list = panel.querySelector<HTMLElement>('[data-list]')!;

  /* Unequip row first. */
  const unequipBtn = document.createElement('button');
  unequipBtn.type = 'button';
  unequipBtn.className = 'consumable-picker-card consumable-picker-card--unequip';
  unequipBtn.innerHTML = `
    <div class="consumable-picker-card-glyph">·</div>
    <div class="consumable-picker-card-body">
      <div class="consumable-picker-card-name">— Empty slot —</div>
      <div class="consumable-picker-card-desc">Clear this slot.</div>
    </div>
  `;
  unequipBtn.addEventListener('click', () => {
    opts.store.assignHotbarSlot(opts.slotIdx, null);
    close();
  });
  list.appendChild(unequipBtn);

  /* One row per consumable id — show count from inventory; zero-count rows are
   * still clickable so the player can pre-reserve a slot for an item they're
   * about to acquire. */
  for (const id of CONSUMABLE_ITEM_IDS) {
    const meta = CONSUMABLE_META[id as ConsumableItemId];
    const count = Math.floor(state.inventory[id] ?? 0);
    const isEquipped = currentItem === id;
    const btn = document.createElement('button');
    btn.type = 'button';
    let klass = 'consumable-picker-card';
    if (isEquipped) klass += ' consumable-picker-card--equipped';
    if (count === 0) klass += ' consumable-picker-card--zero';
    btn.className = klass;
    btn.innerHTML = `
      <div class="consumable-picker-card-glyph" style="color:${meta.accent}">${meta.glyph}</div>
      <div class="consumable-picker-card-body">
        <div class="consumable-picker-card-name">
          ${meta.label}
          ${isEquipped ? '<span class="consumable-picker-card-equipped-pill">In slot</span>' : ''}
        </div>
        <div class="consumable-picker-card-count">In inventory: ${count}</div>
        <div class="consumable-picker-card-desc">${meta.description}</div>
      </div>
    `;
    btn.addEventListener('click', () => {
      opts.store.assignHotbarSlot(opts.slotIdx, id);
      close();
    });
    list.appendChild(btn);
  }

  function close(): void {
    document.removeEventListener('keydown', onKey, true);
    if (backdrop.parentElement) backdrop.parentElement.removeChild(backdrop);
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  panel.querySelector<HTMLButtonElement>('.consumable-picker-close')!.addEventListener('click', close);

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
