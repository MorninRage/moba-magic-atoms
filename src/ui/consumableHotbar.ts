/**
 * Awakened-mode 6-slot consumable hotbar (1-2-3-4-5-6 number-key bar).
 *
 * Reusable across multiple surfaces:
 *   - Awakened HUD (above the existing vital bars hotbar) — primary in-game use.
 *   - Inventory tab — so the player can manage slots without leaving the deck UI.
 *   - Decks tab — same convenience.
 *
 * **Interaction:**
 *   - Click an EMPTY slot -> opens `consumableSlotPickerModal` to assign.
 *   - Click a FILLED slot -> EITHER consumes the item (in awakened mode) OR opens
 *     the picker to reassign (in deck mode where there's nothing to "use").
 *     `useOnFilledClick` opt drives which behavior is active.
 *   - Right-click any slot (filled or empty) -> opens the picker. (Right-click is
 *     the universal "manage this slot" — works regardless of mode.)
 *
 * Number-key activation is handled in `freeRoamControls.ts` (1..6), not here.
 * The visual just matches what those keys do.
 */
import type { GameStore } from '../core/gameStore';
import { CONSUMABLE_META, isConsumableItemId } from '../data/consumables';
import { openConsumableSlotPickerModal } from './consumableSlotPickerModal';

export interface ConsumableHotbarHandle {
  dispose(): void;
}

interface MountOpts {
  /** Game shell element where the picker modal mounts (z-index 95). */
  modalHost: HTMLElement;
  /**
   * When true, clicking a filled slot CONSUMES the item (calls `useHotbarSlot`).
   * When false, clicking a filled slot is a no-op — assignment goes through the
   * inline `quickEquipPanel` on the inventory page instead, NOT a popup modal
   * (per player feedback that the modal felt like leaving the page). Right-click
   * still always opens the picker modal as a power-user shortcut. Set true for
   * the awakened HUD, false for the deck-mode inventory/decks tabs.
   */
  useOnFilledClick: boolean;
  /** Optional helper text rendered above the slots. */
  helperText?: string;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .consumable-hotbar {
      display: flex; flex-direction: column; gap: 6px;
      margin: 12px 0;
    }
    .consumable-hotbar__helper {
      font-size: 0.78rem; color: var(--muted, #94a3b8);
      margin: 0; line-height: 1.4;
    }
    .consumable-hotbar__slots {
      display: flex; gap: 8px; flex-wrap: wrap;
    }
    .consumable-hotbar__slot {
      position: relative;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 64px; height: 70px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s, transform 0.08s;
      font: inherit; color: inherit;
      padding: 0;
    }
    .consumable-hotbar__slot:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.22);
      transform: translateY(-1px);
    }
    .consumable-hotbar__slot--empty .consumable-hotbar__slot-glyph {
      opacity: 0.35;
    }
    .consumable-hotbar__slot-key {
      position: absolute; top: 3px; left: 6px;
      font-size: 0.65rem; opacity: 0.55;
      pointer-events: none;
    }
    .consumable-hotbar__slot-glyph {
      font-size: 1.7rem; line-height: 1; margin-top: 8px;
    }
    .consumable-hotbar__slot-count {
      font-size: 0.7rem; opacity: 0.85; margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .consumable-hotbar__slot-empty-label {
      font-size: 0.65rem; opacity: 0.55; margin-top: 4px;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    .consumable-hotbar__slot--out-of-stock {
      opacity: 0.55; cursor: not-allowed;
    }
    .consumable-hotbar__slot--out-of-stock .consumable-hotbar__slot-count {
      color: #ff8a8a;
    }
  `;
  document.head.appendChild(style);
}

function renderSlots(
  container: HTMLElement,
  state: ReturnType<GameStore['getState']>,
): void {
  const slots = state.hotbarSlots;
  const fragments: string[] = [];
  for (let i = 0; i < 6; i++) {
    const itemId = slots[i];
    const keyLabel = String(i + 1);
    if (!itemId || !isConsumableItemId(itemId)) {
      fragments.push(`
        <button type="button"
          class="consumable-hotbar__slot consumable-hotbar__slot--empty"
          data-hotbar-slot="${i}"
          title="Slot ${keyLabel} — click to assign a consumable. Press ${keyLabel} in awakened mode to use.">
          <span class="consumable-hotbar__slot-key">${keyLabel}</span>
          <span class="consumable-hotbar__slot-glyph">+</span>
          <span class="consumable-hotbar__slot-empty-label">Empty</span>
        </button>
      `);
      continue;
    }
    const meta = CONSUMABLE_META[itemId];
    const count = Math.floor(state.inventory[itemId] ?? 0);
    const outOfStock = count <= 0;
    const klass = `consumable-hotbar__slot${outOfStock ? ' consumable-hotbar__slot--out-of-stock' : ''}`;
    fragments.push(`
      <button type="button"
        class="${klass}"
        data-hotbar-slot="${i}"
        style="border-color:${meta.accent}66;background:${outOfStock ? 'rgba(255,80,80,0.04)' : `${meta.accent}15`}"
        title="${meta.label} (slot ${keyLabel}, key ${keyLabel}) — ${count} in inventory. Right-click to reassign.">
        <span class="consumable-hotbar__slot-key">${keyLabel}</span>
        <span class="consumable-hotbar__slot-glyph" style="color:${meta.accent}">${meta.glyph}</span>
        <span class="consumable-hotbar__slot-count">${count}</span>
      </button>
    `);
  }
  container.innerHTML = fragments.join('');
}

export function mountConsumableHotbar(
  parent: HTMLElement,
  store: GameStore,
  opts: MountOpts,
): ConsumableHotbarHandle {
  injectStyles();

  const root = document.createElement('div');
  root.className = 'consumable-hotbar';
  if (opts.helperText) {
    const helper = document.createElement('p');
    helper.className = 'consumable-hotbar__helper';
    helper.textContent = opts.helperText;
    root.appendChild(helper);
  }
  const slotsEl = document.createElement('div');
  slotsEl.className = 'consumable-hotbar__slots';
  root.appendChild(slotsEl);
  parent.appendChild(root);

  function readSlotIdx(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-hotbar-slot]');
    if (!el) return -1;
    const idx = Number(el.dataset.hotbarSlot);
    return Number.isInteger(idx) && idx >= 0 && idx < 6 ? idx : -1;
  }

  /* Left-click: in awakened HUD (`useOnFilledClick: true`), consumes the slotted
   * item OR opens picker for empty slots. In deck-mode pages (`useOnFilledClick:
   * false`), the bar is preview-only — assignment goes through the inline
   * `quickEquipPanel` instead. Empty-slot click in either case still opens the
   * modal as the only way to assign from the awakened HUD. */
  slotsEl.addEventListener('click', (e) => {
    const idx = readSlotIdx(e.target);
    if (idx < 0) return;
    const itemId = store.getState().hotbarSlots[idx];
    if (itemId) {
      if (opts.useOnFilledClick) store.useHotbarSlot(idx);
      /* else: deck-mode preview — no-op on filled-slot click. */
      return;
    }
    /* Empty slot: open the modal regardless of mode (only assignment path
     * available from the awakened HUD; on the inventory page the player will
     * normally use the quick-equip panel below, but the modal still works as
     * a fallback). */
    openConsumableSlotPickerModal({ slotIdx: idx, host: opts.modalHost, store });
  });

  /* Right-click: always opens the picker modal (power-user shortcut to clear/
   * reassign without scrolling to the inline panel). */
  slotsEl.addEventListener('contextmenu', (e) => {
    const idx = readSlotIdx(e.target);
    if (idx < 0) return;
    e.preventDefault();
    openConsumableSlotPickerModal({ slotIdx: idx, host: opts.modalHost, store });
  });

  /* Sig-gated re-render — slots, inventory counts of slotted items. */
  let lastSig = '';
  function refresh(): void {
    const s = store.getState();
    const slotsKey = s.hotbarSlots.map((id) => id ?? '_').join('|');
    /* Inventory-count signature includes ONLY the items that are currently slotted
     * — changes to other inventory counts don't touch the hotbar visual, so we
     * don't redraw on every store emit during steady-state harvesting. */
    const countsKey = s.hotbarSlots
      .map((id) => (id ? `${id}:${Math.floor(s.inventory[id] ?? 0)}` : '_'))
      .join('|');
    const sig = `${slotsKey}#${countsKey}`;
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
