/**
 * Wandering merchant: visit schedule, sell prices, and special stock (bundles + card charters).
 *
 * **Time model (intentional):** Visits use **wall clock** (`Date.now()`), not `simHour` / sun cycle.
 * The dock sky/day-night uses a separate sim timeline (`hourPerRealSecond`, etc.). Keeping both avoids
 * tying idle “come back in X minutes” pacing to editor time, paused sim, or fast days — and prevents
 * mistaken “unify everything to one clock” refactors that would break saves and expectations.
 */
import { DURABILITY_ITEM_IDS } from './content';
import type { CardDef } from '../core/types';

/** How long each caravan stays at camp (ms). */
export const MERCHANT_STAY_MS = 3.5 * 60 * 1000;

/** Gap between visits after they leave (ms). */
export const MERCHANT_GAP_MS = 6 * 60 * 1000;

/** Time until first visit on a new run (ms). */
export const MERCHANT_FIRST_DELAY_MS = 50 * 1000;

/** Structures and other ids you cannot sell (would brick the run). */
const SELL_BLOCKLIST = new Set<string>([
  'campfire',
  'workbench',
  'forge',
  'kitchen',
  'garden_plot',
  'well',
  'food_forest',
  'cooler',
  'repair_bench',
  'bandage',
  'stim',
  ...DURABILITY_ITEM_IDS,
]);

const BASE_SELL: Record<string, number> = {
  wood: 0.32,
  stone: 0.28,
  fiber: 0.38,
  berries: 0.42,
  water: 0.25,
  herb: 0.55,
  raw_meat: 0.85,
  cooked_meat: 0.65,
  leather: 0.9,
  coal: 0.75,
  magic_dust: 1.15,
  iron_ore: 1.05,
  copper_ore: 1.0,
  tin_ore: 0.95,
  zinc_ore: 0.95,
  silver_ore: 1.4,
  gold_ore: 1.8,
  platinum_ore: 2.2,
  iron_ingot: 2.2,
  copper_ingot: 2.0,
  tin_ingot: 2.0,
  zinc_ingot: 2.0,
  bronze_ingot: 2.6,
  brass_ingot: 2.6,
  steel_ingot: 3.2,
  silver_ingot: 3.8,
  gold_ingot: 4.5,
  platinum_ingot: 5.2,
};

export function merchantSellPricePerUnit(resourceId: string): number {
  if (SELL_BLOCKLIST.has(resourceId)) return 0;
  if (BASE_SELL[resourceId] !== undefined) return BASE_SELL[resourceId]!;
  if (resourceId.endsWith('_ore')) return 1.0;
  if (resourceId.endsWith('_ingot')) return 2.3;
  return 0;
}

export function canSellResourceToMerchant(resourceId: string): boolean {
  return merchantSellPricePerUnit(resourceId) > 0;
}

/** Coin earned for selling `amount` units (floored total). */
export function merchantSellPayout(resourceId: string, amount: number): number {
  const u = merchantSellPricePerUnit(resourceId);
  if (u <= 0 || amount <= 0) return 0;
  return Math.max(0, Math.floor(amount * u));
}

export type MerchantOfferKind = 'inventory' | 'card';

export type MerchantOfferDef = {
  id: string;
  kind: MerchantOfferKind;
  label: string;
  description: string;
  price: number;
  maxPerVisit: number;
  minPveWave: number;
  /** For kind inventory */
  grant?: Record<string, number>;
  /** For kind card — unlock without spending recipe items (prerequisite cards must still be unlocked). */
  cardId?: string;
};

export const MERCHANT_OFFERS: MerchantOfferDef[] = [
  {
    id: 'm_survival_kit',
    kind: 'inventory',
    label: 'Survival kit',
    description: 'Bandages and stims for the road.',
    price: 215,
    maxPerVisit: 2,
    minPveWave: 0,
    grant: { bandage: 4, stim: 3 },
  },
  {
    id: 'm_dust_satchel',
    kind: 'inventory',
    label: 'Dust satchel',
    description: 'Refined ley residue — good for spells and crafts.',
    price: 125,
    maxPerVisit: 2,
    minPveWave: 0,
    grant: { magic_dust: 28 },
  },
  {
    id: 'm_ration_crate',
    kind: 'inventory',
    label: 'Ration crate',
    description: 'Smoked cuts; won’t spoil on the shelf.',
    price: 58,
    maxPerVisit: 3,
    minPveWave: 0,
    grant: { cooked_meat: 12 },
  },
  {
    id: 'm_smith_bundle',
    kind: 'inventory',
    label: 'Smith’s bundle',
    description: 'Ore and fuel for the forge.',
    price: 88,
    maxPerVisit: 2,
    minPveWave: 1,
    grant: { iron_ore: 10, coal: 8 },
  },
  {
    id: 'm_leather_lot',
    kind: 'inventory',
    label: 'Tanner’s lot',
    description: 'Hides from the lowlands.',
    price: 44,
    maxPerVisit: 2,
    minPveWave: 0,
    grant: { leather: 9 },
  },
  {
    id: 'm_bench_rush',
    kind: 'card',
    label: 'Bench rush deed',
    description: 'Courier-delivered workbench plans — you still need a campfire in camp.',
    price: 118,
    maxPerVisit: 1,
    minPveWave: 0,
    cardId: 'c_card_workbench_blueprint',
  },
  {
    id: 'm_awakening_folio',
    kind: 'card',
    label: 'Awakening folio',
    description: 'Stamped primer for stray ley — magic deck entry without the berry tithe.',
    price: 92,
    maxPerVisit: 1,
    minPveWave: 1,
    cardId: 'c_magic_awakening',
  },
];

export function merchantOfferById(id: string): MerchantOfferDef | undefined {
  return MERCHANT_OFFERS.find((o) => o.id === id);
}

/** Prerequisite cards satisfied; does not check items (merchant bypasses items). */
export function merchantCardPrereqsMet(card: CardDef, unlocked: Set<string>): boolean {
  if (card.requiresCards) {
    for (const id of card.requiresCards) {
      if (!unlocked.has(id)) return false;
    }
  }
  return true;
}
