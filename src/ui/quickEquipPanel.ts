/**
 * Inline quick-equip panel — embedded inside the Inventory page so the player can
 * assign consumables to their 6-slot hotbar WITHOUT leaving the page or popping
 * a modal that obscures the inventory grid. The original modal-based picker felt
 * like "going to another page" which made it hard to compare slot state vs.
 * available items at a glance — exactly what the user reported.
 *
 * **Layout:** one row per consumable that the player has (or could have) in
 * inventory. Each row shows:
 *   - Glyph + name + live inventory count.
 *   - 6 slot buttons (1-6). Each button highlights green when THIS item is
 *     currently in THAT slot. Click any button to assign (single click = done).
 *   - Click an already-assigned button (highlighted) to unassign.
 *
 * **Visibility:** consumables with zero count are still shown (greyed) so the
 * player can pre-reserve a slot for an item they're about to acquire — same
 * affordance as the modal picker. Adding a new consumable is a 1-line update
 * to `CONSUMABLE_ITEM_IDS` (the panel auto-renders all entries).
 */
import type { GameStore } from '../core/gameStore';
import { CONSUMABLE_ITEM_IDS, CONSUMABLE_META, type ConsumableItemId } from '../data/consumables';

export interface QuickEquipPanelHandle {
  dispose(): void;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .quick-equip-panel {
      margin: 14px 0 18px 0;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .quick-equip-panel__title {
      font-size: 0.95rem; font-weight: 700;
      margin: 0 0 4px 0; color: var(--text, #e6f3ff);
    }
    .quick-equip-panel__hint {
      font-size: 0.78rem; color: var(--muted, #94a3b8);
      margin: 0 0 10px 0; line-height: 1.4;
    }
    .quick-equip-row {
      display: flex; align-items: center; gap: 12px;
      padding: 8px 4px;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .quick-equip-row:first-of-type { border-top: none; }
    .quick-equip-row__glyph {
      font-size: 1.5rem; line-height: 1;
      width: 32px; text-align: center;
    }
    .quick-equip-row__info { flex: 1; min-width: 0; }
    .quick-equip-row__name {
      font-size: 0.95rem; font-weight: 600;
    }
    .quick-equip-row__count {
      font-size: 0.78rem; opacity: 0.75; margin-top: 1px;
      font-variant-numeric: tabular-nums;
    }
    .quick-equip-row__count--zero { color: #ff8a8a; opacity: 0.85; }
    .quick-equip-row__buttons {
      display: flex; gap: 4px;
    }
    .quick-equip-slot-btn {
      width: 30px; height: 30px;
      border-radius: 6px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      color: inherit;
      cursor: pointer;
      font-size: 0.85rem; font-weight: 600;
      font-family: inherit;
      padding: 0;
      transition: background 0.12s, border-color 0.12s, transform 0.06s;
    }
    .quick-equip-slot-btn:hover {
      background: rgba(255,255,255,0.10);
      border-color: rgba(255,255,255,0.30);
      transform: translateY(-1px);
    }
    .quick-equip-slot-btn--equipped {
      background: rgba(102,224,255,0.18);
      border-color: #66e0ff;
      color: #66e0ff;
    }
    .quick-equip-slot-btn--equipped:hover {
      background: rgba(255,140,140,0.16);
      border-color: #ff8a8a;
      color: #ff8a8a;
    }
    .quick-equip-slot-btn--equipped:hover::after {
      content: '×';
    }
    .quick-equip-row--zero { opacity: 0.55; }
  `;
  document.head.appendChild(style);
}

interface MountOpts {
  /** Optional override of which consumable ids appear (default: all). */
  ids?: readonly ConsumableItemId[];
}

export function mountQuickEquipPanel(
  parent: HTMLElement,
  store: GameStore,
  opts: MountOpts = {},
): QuickEquipPanelHandle {
  injectStyles();

  const ids = opts.ids ?? CONSUMABLE_ITEM_IDS;

  const root = document.createElement('div');
  root.className = 'quick-equip-panel';
  root.innerHTML = `
    <h3 class="quick-equip-panel__title">Quick-equip</h3>
    <p class="quick-equip-panel__hint">Click a slot button (1-6) to assign that consumable to your hotbar. Click an already-equipped slot (cyan) to unequip. In awakened mode, press the matching number key to consume.</p>
    <div class="quick-equip-panel__rows" data-rows></div>
  `;
  const rowsEl = root.querySelector<HTMLElement>('[data-rows]')!;
  parent.appendChild(root);

  /* Click delegation — single listener for all buttons across all rows. */
  rowsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-quick-equip-assign]');
    if (!btn) return;
    const itemId = btn.dataset.itemId as ConsumableItemId | undefined;
    const slotIdx = Number(btn.dataset.slotIdx);
    if (!itemId || !Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= 6) return;
    const currentInSlot = store.getState().hotbarSlots[slotIdx];
    if (currentInSlot === itemId) {
      /* Click an equipped slot for THIS item -> unassign (clear the slot). */
      store.assignHotbarSlot(slotIdx, null);
    } else {
      /* Assign (or replace whatever was there) — single click does it. */
      store.assignHotbarSlot(slotIdx, itemId);
    }
  });

  /* Sig-gated re-render — slot assignments + counts of consumable items. */
  let lastSig = '';
  function refresh(): void {
    const s = store.getState();
    const slotsKey = s.hotbarSlots.map((id) => id ?? '_').join('|');
    const countsKey = ids.map((id) => `${id}:${Math.floor(s.inventory[id] ?? 0)}`).join('|');
    const sig = `${slotsKey}#${countsKey}`;
    if (sig === lastSig) return;
    lastSig = sig;

    const rows: string[] = [];
    for (const itemId of ids) {
      const meta = CONSUMABLE_META[itemId];
      const count = Math.floor(s.inventory[itemId] ?? 0);
      const isZero = count <= 0;
      const slotButtons: string[] = [];
      for (let i = 0; i < 6; i++) {
        const equipped = s.hotbarSlots[i] === itemId;
        const klass = `quick-equip-slot-btn${equipped ? ' quick-equip-slot-btn--equipped' : ''}`;
        const title = equipped
          ? `Slot ${i + 1} — currently ${meta.label}. Click to unequip.`
          : `Assign ${meta.label} to slot ${i + 1}.`;
        slotButtons.push(`<button type="button"
          class="${klass}"
          data-quick-equip-assign
          data-item-id="${itemId}"
          data-slot-idx="${i}"
          title="${title}"
        >${i + 1}</button>`);
      }
      rows.push(`
        <div class="quick-equip-row${isZero ? ' quick-equip-row--zero' : ''}">
          <span class="quick-equip-row__glyph" style="color:${meta.accent}">${meta.glyph}</span>
          <div class="quick-equip-row__info">
            <div class="quick-equip-row__name">${meta.label}</div>
            <div class="quick-equip-row__count${isZero ? ' quick-equip-row__count--zero' : ''}">In bag: ${count}</div>
          </div>
          <div class="quick-equip-row__buttons">${slotButtons.join('')}</div>
        </div>
      `);
    }
    rowsEl.innerHTML = rows.join('');
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
