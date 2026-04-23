/**
 * Awakened-mode hotbar consumable registry.
 *
 * Defines which inventory items can be slotted into the 6-key consumable hotbar and
 * the metadata needed to render them (label, glyph, hue) plus the use-action that
 * fires when the player presses the assigned number key. The store maps each id to
 * one of `consumeFood` / `drinkWater` / etc. via `useHotbarSlot()`.
 *
 * **Adding a new consumable:**
 *   1. Add the inventory id to `CONSUMABLE_ITEM_IDS`.
 *   2. Add label + glyph + accent color to `CONSUMABLE_META`.
 *   3. Wire the use-action in `GameStore.useHotbarSlot()` (a new `case` in the
 *      switch). Examples: cooked meals could call `consumeFood`, mana potions
 *      could call a new `consumeManaPotion()`, healing herbs could call a new
 *      `consumeHerb()`.
 *
 * The list is static-final so Vite tree-shakes any new id correctly. Don't gate
 * registry entries on dev flags here — gate VISIBILITY in the picker UI instead.
 */

export const CONSUMABLE_ITEM_IDS = [
  'berries',
  'cooked_meat',
  'water',
] as const;

export type ConsumableItemId = typeof CONSUMABLE_ITEM_IDS[number];

export interface ConsumableMeta {
  /** Display label shown in the hotbar slot + picker modal. */
  label: string;
  /** Single-glyph icon for the slot — uses Unicode emoji-style symbols so we don't
   * ship per-item bitmaps. Picked from common nature/food/water glyphs. */
  glyph: string;
  /** Slot accent color (CSS color). Drives border + glow when slot is filled. */
  accent: string;
  /** Short status-line description shown when the player hovers / picker tooltip. */
  description: string;
}

export const CONSUMABLE_META: Record<ConsumableItemId, ConsumableMeta> = {
  berries: {
    label: 'Berries',
    glyph: '\u{1F347}',
    accent: '#a663ff',
    description: 'Light snack — restores some hunger. Stack of berries from foraging.',
  },
  cooked_meat: {
    label: 'Cooked meat',
    glyph: '\u{1F356}',
    accent: '#ff7a4a',
    description: 'Heavy meal — restores hunger AND a small amount of HP. Cook raw meat at a campfire.',
  },
  water: {
    label: 'Water bucket',
    glyph: '\u{1F4A7}',
    accent: '#4fb6ff',
    description: 'Fill at a creek (E near water) or via the well. Restores thirst.',
  },
};

/** Type-guard: check whether an arbitrary inventory id is a consumable. */
export function isConsumableItemId(id: string | null | undefined): id is ConsumableItemId {
  if (!id) return false;
  return (CONSUMABLE_ITEM_IDS as readonly string[]).includes(id);
}
