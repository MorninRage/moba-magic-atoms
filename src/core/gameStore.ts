import { playConsumeSound, playWorldSoundForGather, setBattleMusicMode } from '../audio/audioBridge';
import {
  IDLE_SLOT_INITIAL,
  IDLE_SLOT_MAX,
  nextIdleSlotUnlockCost as computeIdleSlotUnlockCost,
  STARTING_ENERGY,
  STARTING_PLAYER_HP,
  MAX_ENERGY,
  cardById,
  cards as cardDefs,
  defaultStations,
  DURABILITY_ITEM_IDS,
  EQUIPPABLE_PICK_IDS,
  EQUIPPABLE_SHIELD_IDS,
  EQUIPPABLE_WEAPON_IDS,
  helperById,
  mergeStation,
  BATTLE_HEAL_BANDAGE,
  BATTLE_HEAL_STIM,
  pveEnemies,
  recipeById,
  recipes,
  helpers,
  SPOILAGE_KEYS,
} from '../data/content';
import { WITCH_ENEMY_BY_ID, WITCH_ENEMY_BY_SHARD } from '../data/witchEnemies';
import {
  AXE_BATTLE_WEAR,
  AXE_TIER_ORDER,
  AXE_WOOD_MULT,
  PICK_ORE_YIELD_MULT,
  PICK_STONE_YIELD_MULT,
  PICK_TIER_ORDER,
  PICK_WEAR_FACTOR,
  SWORD_BATTLE_WEAR,
  WEAPON_DAMAGE_BONUS,
} from '../data/metalConstants';
import type {
  AwakenedMobInstance,
  AwakenedMobKind,
  BattleState,
  CabinMaterialTier,
  CabinPieceKind,
  CardDef,
  CharacterPresetId,
  CraftStation,
  EnemyDef,
  EquipSlot,
  EquipmentState,
  GameMode,
  GameState,
  PlacedCabinPiece,
  PlacedCraftStation,
  PlacedCraftStationKind,
  RealmMode,
  ShardState,
  TutorialState,
  GatherActionGroup,
  HelperDef,
  MerchantState,
  OnlineSessionMeta,
  RecipeDef,
  WitchShardId,
} from './types';
import { CHARACTER_PRESET_IDS, DEFAULT_CHARACTER_PRESET_ID } from '../data/characterPresets';
import { getRoomHub } from '../net/roomHubBridge';
import type {
  RemotePresenceEntry,
  RoomHubEvent,
  RoomPlayerPublic,
  RoomSnapshot,
} from '../net/roomTypes';
import {
  actionIdToHarvestKind,
  allHarvestSlotPositions,
  createInitialHarvestPatches,
  HARVEST_RESPAWN_MS,
  harvestNodeReady,
  normalizeHarvestPatches,
  type HarvestNodeKind,
} from '../world/idleCraftHarvestNodes';
import {
  createInitialHarvestMastery,
  harvestYieldMultiplier,
  masteryUpgradeCost,
  normalizeHarvestMastery,
  regrowthTimeMultiplier,
  SEAL_STRAIN_CAP,
  veinStrainPerGather,
  HARVEST_MASTERY_MAX_TIER,
  type MasteryBranch,
} from '../data/rpgHarvestMastery';
import {
  canSellResourceToMerchant,
  MERCHANT_GAP_MS,
  MERCHANT_FIRST_DELAY_MS,
  MERCHANT_STAY_MS,
  merchantCardPrereqsMet,
  merchantOfferById,
  merchantSellPayout,
} from '../data/wanderingMerchant';

/**
 * Manual gathers grant loot only after the character preview finishes (~4–5s each).
 * Bump yields so resources per real minute stay comparable to the old ~1s click cadence;
 * axe/pick tiers and helpers still stack on top (relative upgrades unchanged).
 */
const MANUAL_GATHER_YIELD_MULT = 4.25;

/** Coal/iron/etc. without a pick: fraction of a tier-1 pick run (clearly worse than any pick). */
const ORE_BARE_HANDS_MULT = 0.24;

const SAVE_KEY = 'moba-magic-atoms-save-v1';

function isAxeWeaponId(w: string | null): boolean {
  return w === 'axe' || (!!w && w.endsWith('_axe'));
}

/** Max additive idle bonus from helpers (sum of idleBonus); avoids runaway multiplicative stacking. */
const IDLE_HELPER_BONUS_CAP = 1.9;
const STATE_VERSION = 25;

/**
 * Battles between witch encounters. Every Nth PvE win, the next start-battle spawns the
 * next pending witch instead of a regular enemy. 3 witches × 15 = ~45 wins to free yourself.
 * Locked in `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §2.
 */
const WITCH_BATTLE_INTERVAL = 15;

const DEFAULT_WITCH_ORDER: WitchShardId[] = ['cori', 'jenny', 'kristin'];

/**
 * Dev override flag (read each call so toggling the localStorage value takes effect without
 * a reload). Default `'1'` per Phase A — keeps the awakening tab + Break button always
 * available while we iterate. Flip to `'0'` to gate behind real shard collection.
 */
function isDevAwakeningUnlocked(): boolean {
  try {
    const v = localStorage.getItem('idleCraft.devUnlockAwakening');
    return v == null ? true : v === '1';
  } catch {
    return true;
  }
}

function defaultTutorialNotStarted(): TutorialState {
  return { version: 1, status: 'not_started', stepId: 'intro' };
}

function defaultTutorialCompleted(): TutorialState {
  return { version: 1, status: 'completed', stepId: 'done' };
}

/**
 * Permadeath rebuilds state with {@link createInitialState} (tutorial `not_started`).
 * That status pauses hunger/thirst decay — so a new camp after death would freeze meters at 88 until
 * Guided/Skip. Preserve finished/skipped tours; otherwise treat the wipe as having “graduated” FTUE.
 */
function tutorialAfterPermadeathWipe(prev: TutorialState): TutorialState {
  if (prev.status === 'skipped' || prev.status === 'completed') {
    return {
      version: 1,
      status: prev.status,
      stepId: 'done',
      flags: prev.flags,
    };
  }
  return defaultTutorialCompleted();
}

const MAGIC_ENTRY_CARD_ID = 'c_magic_awakening';
const STARTER_IDLE_CARD = 'c_idle_windfall';

function cloneState(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s)) as GameState;
}

function normalizeMerchantState(raw: unknown, now: number): MerchantState {
  if (!raw || typeof raw !== 'object') {
    return {
      presentUntilMs: 0,
      nextVisitAtMs: now + MERCHANT_FIRST_DELAY_MS,
      soldThisVisit: {},
    };
  }
  const r = raw as Record<string, unknown>;
  const sold = r.soldThisVisit;
  const soldThisVisit =
    sold && typeof sold === 'object' && !Array.isArray(sold)
      ? { ...(sold as Record<string, number>) }
      : {};
  return {
    presentUntilMs: typeof r.presentUntilMs === 'number' ? r.presentUntilMs : 0,
    nextVisitAtMs:
      typeof r.nextVisitAtMs === 'number' ? r.nextVisitAtMs : now + MERCHANT_FIRST_DELAY_MS,
    soldThisVisit,
  };
}

function defaultEquipment(): EquipmentState {
  return { weapon: null, armor: null, shield: null, pick: null };
}

export function createInitialState(): GameState {
  const now = Date.now();
  return {
    version: STATE_VERSION,
    gameMode: 'solo',
    onlineSession: null,
    characterPresetId: DEFAULT_CHARACTER_PRESET_ID,
    inventory: {
      stone: 4,
      wood: 6,
      fiber: 2,
      berries: 3,
      water: 2,
      iron_ore: 0,
      iron_ingot: 0,
      coal: 0,
      raw_meat: 0,
      cooked_meat: 0,
      herb: 0,
      leather: 0,
      magic_dust: 0,
      bandage: 0,
      stim: 0,
      copper_ore: 0,
      tin_ore: 0,
      zinc_ore: 0,
      silver_ore: 0,
      gold_ore: 0,
      platinum_ore: 0,
      copper_ingot: 0,
      tin_ingot: 0,
      zinc_ingot: 0,
      bronze_ingot: 0,
      brass_ingot: 0,
      steel_ingot: 0,
      silver_ingot: 0,
      gold_ingot: 0,
      platinum_ingot: 0,
      copper_pickaxe: 0,
      bronze_pickaxe: 0,
      brass_pickaxe: 0,
      steel_pickaxe: 0,
      silver_pickaxe: 0,
      gold_pickaxe: 0,
      platinum_pickaxe: 0,
      copper_axe: 0,
      bronze_axe: 0,
      brass_axe: 0,
      steel_axe: 0,
      bronze_sword: 0,
      steel_sword: 0,
      silver_sword: 0,
      gold_sword: 0,
      platinum_sword: 0,
      /* Phase D — magic crystal harvest + crystal staff/wand crafting line. */
      magic_crystal: 0,
      crystal_focus: 0,
      apprentice_wand: 0,
      journeyman_staff: 0,
      archmage_staff: 0,
      /* Phase A — talisman shards dropped on witch defeat (one per witch, max 1 each). */
      talisman_shard_cori: 0,
      talisman_shard_jenny: 0,
      talisman_shard_kristin: 0,
    },
    currency: 5,
    mana: 0,
    maxMana: 10,
    playerHp: STARTING_PLAYER_HP,
    playerMaxHp: STARTING_PLAYER_HP,
    hunger: 88,
    thirst: 88,
    unlockedCardIds: cardDefs.filter((c) => c.unlockedByDefault).map((c) => c.id),
    idleSlots: Array(IDLE_SLOT_INITIAL).fill(null),
    combatDeck: ['c_fist'],
    hiredHelperIds: [],
    stations: defaultStations(),
    lastRealMs: now,
    battle: null,
    pveWave: 0,
    equipment: defaultEquipment(),
    toolDurability: {},
    spoilAccumulatorMs: 0,
    lastDeathHeadline: null,
    lastDeathBody: null,
    tutorial: defaultTutorialNotStarted(),
    harvestPatches: createInitialHarvestPatches(),
    harvestMastery: createInitialHarvestMastery(),
    merchant: {
      presentUntilMs: 0,
      nextVisitAtMs: now + MERCHANT_FIRST_DELAY_MS,
      soldThisVisit: {},
    },
    realmMode: 'deck',
    shards: { cori: false, jenny: false, kristin: false },
    witchBattlesUntilNext: WITCH_BATTLE_INTERVAL,
    witchOrder: [...DEFAULT_WITCH_ORDER],
    magicCrystalsHarvested: 0,
    placedCabinPieces: [],
    placedCabinPieceCounter: 0,
    equippedOffensiveSpellId: null,
    equippedDefensiveSpellId: null,
    combatMode: 'magic',
    hotbarSlots: [null, null, null, null, null, null],
    placedCraftStations: [],
    placedCraftStationCounter: 0,
    torchEquipped: true,
  };
}

function migrateLoaded(p: Record<string, unknown>): GameState {
  const v = typeof p.version === 'number' ? p.version : 1;
  if (v < 2) {
    p.playerHp = STARTING_PLAYER_HP;
    p.playerMaxHp = STARTING_PLAYER_HP;
    p.hunger = 88;
    p.thirst = 88;
    p.equipment = p.equipment ?? defaultEquipment();
    p.toolDurability = p.toolDurability ?? {};
    p.spoilAccumulatorMs = p.spoilAccumulatorMs ?? 0;
  }
  if (v < 3) {
    const ids = p.unlockedCardIds;
    if (Array.isArray(ids) && !ids.includes(STARTER_IDLE_CARD)) ids.push(STARTER_IDLE_CARD);
  }
  if (v < 4) {
    (p as Record<string, unknown>).lastDeathReason = null;
  }
  if (v < 5) {
    const legacy = (p as Record<string, unknown>).lastDeathReason;
    if (typeof legacy === 'string' && legacy.length > 0) {
      p.lastDeathHeadline = 'You died';
      p.lastDeathBody = legacy;
    } else {
      p.lastDeathHeadline = null;
      p.lastDeathBody = null;
    }
    delete (p as Record<string, unknown>).lastDeathReason;
  }
  if (v < 6) {
    const eq = p.equipment as Record<string, unknown> | null | undefined;
    if (eq && eq.pick === undefined) eq.pick = null;
  }
  if (v < 7) {
    const inv = p.inventory as Record<string, number>;
    if (inv.bandage === undefined) inv.bandage = 0;
    if (inv.stim === undefined) inv.stim = 0;
  }
  if (v < 8) {
    const ids = p.unlockedCardIds as string[];
    const sparkIx = ids.indexOf('c_magic_spark');
    if (sparkIx >= 0) {
      ids.splice(sparkIx, 1);
      if (!ids.includes(MAGIC_ENTRY_CARD_ID)) ids.push(MAGIC_ENTRY_CARD_ID);
    }
    const deck = p.combatDeck as string[] | undefined;
    if (Array.isArray(deck)) {
      const next = [...new Set(deck.map((id) => (id === 'c_magic_spark' ? MAGIC_ENTRY_CARD_ID : id)))];
      p.combatDeck = next.length > 0 ? next : ['c_fist'];
    }
  }
  if (v < 9) {
    const inv = p.inventory as Record<string, number>;
    for (const k of [
      'copper_ore',
      'tin_ore',
      'zinc_ore',
      'silver_ore',
      'gold_ore',
      'platinum_ore',
      'copper_ingot',
      'tin_ingot',
      'zinc_ingot',
      'bronze_ingot',
      'brass_ingot',
      'steel_ingot',
      'silver_ingot',
      'gold_ingot',
      'platinum_ingot',
      'copper_pickaxe',
      'bronze_pickaxe',
      'brass_pickaxe',
      'steel_pickaxe',
      'silver_pickaxe',
      'gold_pickaxe',
      'platinum_pickaxe',
      'copper_axe',
      'bronze_axe',
      'brass_axe',
      'steel_axe',
      'bronze_sword',
      'steel_sword',
      'silver_sword',
      'gold_sword',
      'platinum_sword',
    ]) {
      if (inv[k] === undefined) inv[k] = 0;
    }
  }
  if (v < 10) {
    let slots = (p.idleSlots as (string | null)[]) ?? [];
    if (!Array.isArray(slots)) slots = Array(IDLE_SLOT_INITIAL).fill(null);
    if (slots.length > IDLE_SLOT_MAX) slots = slots.slice(0, IDLE_SLOT_MAX);
    while (slots.length < IDLE_SLOT_INITIAL) slots = [...slots, null];
    p.idleSlots = slots;
  }
  if (v < 11) {
    p.gameMode = 'solo';
    p.characterPresetId = DEFAULT_CHARACTER_PRESET_ID;
  }
  if (v < 12) {
    const cid = p.characterPresetId;
    if (typeof cid !== 'string' || !CHARACTER_PRESET_IDS.has(cid as CharacterPresetId)) {
      p.characterPresetId = DEFAULT_CHARACTER_PRESET_ID;
    }
  }
  if (v < 13) {
    p.onlineSession = null;
  }
  if (v < 14) {
    (p as Record<string, unknown>).tutorial = defaultTutorialCompleted();
  }
  if (v < 15) {
    (p as Record<string, unknown>).harvestPatches = createInitialHarvestPatches();
  }
  if (v < 16) {
    (p as Record<string, unknown>).harvestMastery = createInitialHarvestMastery();
  }
  if (v < 17) {
    (p as Record<string, unknown>).merchant = normalizeMerchantState(undefined, Date.now());
  }
  if (v < 18) {
    /* Awakening / shards / witch counter / crystals — see `docs/AWAKENING_AND_FREE_ROAM_PLAN.md`.
     * Existing players keep `realmMode: 'deck'` so the dream-prison UX is unchanged until they
     * progress through the awakening flow (or flip the dev flag). */
    const o = p as Record<string, unknown>;
    o.realmMode = 'deck';
    o.shards = { cori: false, jenny: false, kristin: false };
    o.witchBattlesUntilNext = WITCH_BATTLE_INTERVAL;
    o.witchOrder = [...DEFAULT_WITCH_ORDER];
    o.magicCrystalsHarvested = 0;
    /* New inventory keys for Phase B/D — crystal weapon line + shard items. Default 0 so
     * existing saves don't blow up the inventory map. */
    const inv = (o.inventory as Record<string, number>) ?? {};
    for (const k of [
      'magic_crystal',
      'crystal_focus',
      'apprentice_wand',
      'journeyman_staff',
      'archmage_staff',
      'talisman_shard_cori',
      'talisman_shard_jenny',
      'talisman_shard_kristin',
    ]) {
      if (inv[k] === undefined) inv[k] = 0;
    }
    o.inventory = inv;
  }
  if (v < 19) {
    /* v19 — Phase 1 base building (see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md). New
     * fields default empty so awakened players who pre-date the build system see the
     * world exactly as before until they place their first piece. The crystalWrap slot
     * on each piece is reserved for Phase 3 — including the field now means Phase 3
     * doesn't bump STATE_VERSION again. */
    const o = p as Record<string, unknown>;
    if (!Array.isArray(o.placedCabinPieces)) o.placedCabinPieces = [];
    if (typeof o.placedCabinPieceCounter !== 'number') o.placedCabinPieceCounter = 0;
  }
  if (v < 20) {
    /* v20 — awakened-mode equipped spell slots (offensive + defensive). Default null
     * for older saves; player picks via the hotbar's Magic slots once spells are
     * unlocked. The setters guard against ids that aren't actually unlocked, so a
     * stale legacy value couldn't cast a locked spell anyway. */
    const o = p as Record<string, unknown>;
    if (typeof o.equippedOffensiveSpellId !== 'string' && o.equippedOffensiveSpellId !== null) {
      o.equippedOffensiveSpellId = null;
    }
    if (typeof o.equippedDefensiveSpellId !== 'string' && o.equippedDefensiveSpellId !== null) {
      o.equippedDefensiveSpellId = null;
    }
  }
  if (v < 21) {
    /* v21 — combat-mode toggle (`hit` vs `magic`). Default `'magic'` for legacy
     * saves so a player who already had an offensive spell equipped before this
     * field existed gets the fire-spells-on-LMB behavior they expect. */
    const o = p as Record<string, unknown>;
    if (o.combatMode !== 'hit' && o.combatMode !== 'magic') {
      o.combatMode = 'magic';
    }
  }
  if (v < 22) {
    /* v22 — 6-slot consumable hotbar (1-6 number keys in awakened mode). Default
     * all six slots empty for legacy saves; player assigns via the shortcut bar
     * picker. We normalise to exactly 6 slots in case a future schema bump
     * extends or shrinks the bar (defensive — the player should never hit the
     * "wrong number of slots" branch). */
    const o = p as Record<string, unknown>;
    if (!Array.isArray(o.hotbarSlots) || o.hotbarSlots.length !== 6) {
      o.hotbarSlots = [null, null, null, null, null, null];
    } else {
      /* Sanitise — strings or nulls only; a legacy field with non-string entries
       * gets defaulted to null. */
      o.hotbarSlots = (o.hotbarSlots as unknown[]).map((x) =>
        typeof x === 'string' && x.length > 0 ? x : null,
      );
    }
  }
  if (v < 24) {
    /* v24 — multi-instance awakened-mode craft-station placement.
     *
     * Supersedes the dead-on-arrival v23 single-position model
     * (`awakenedStationPositions: { campfire: { x; z } | null; workbench: ... }`).
     * That field was added by an earlier migration but no code path ever wrote to
     * it — the UI / Build mode skipped wiring entirely. The replacement multi-
     * instance system uses the same shape as `placedCabinPieces`: an array of
     * placed stations, each with id / kind / world XZ + Y / rotation / HP. The
     * Build tab's new "Stations" sub-section drives placement.
     *
     * Migration steps for any save that may be loading at v <= 23:
     *   1. Drop the dead `awakenedStationPositions` field if present (silent
     *      no-op when missing — pre-v23 saves never had it).
     *   2. Initialise `placedCraftStations` to `[]` and the counter to 0.
     *      Players keep zero placed stations until they open Build mode in
     *      awakened realm and place one.
     */
    const o = p as Record<string, unknown>;
    delete o.awakenedStationPositions;
    if (!Array.isArray(o.placedCraftStations)) o.placedCraftStations = [];
    if (typeof o.placedCraftStationCounter !== 'number') o.placedCraftStationCounter = 0;
  }
  if (v < 25) {
    const o = p as Record<string, unknown>;
    if (o.torchEquipped !== true && o.torchEquipped !== false) {
      o.torchEquipped = true;
    }
  }
  p.version = STATE_VERSION;
  return p as unknown as GameState;
}

function hasItems(inv: Record<string, number>, need: Record<string, number>): boolean {
  for (const [k, v] of Object.entries(need)) {
    const have = inv[k] ?? 0;
    if (have + 1e-9 < v) return false;
  }
  return true;
}

/* ============================================================================
 * Cabin building helpers (pure — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §2-3)
 * ============================================================================ */

/**
 * Base material cost per piece kind at tier T0 (`rough_log`). Higher tiers multiply
 * the wood cost AND add a metal-ingot cost via `cabinPieceCost` below. Numbers match
 * the master plan's piece catalog (§2). Values are PROVISIONAL — Phase 4 balance pass
 * will retune once the damage system exists.
 */
const CABIN_PIECE_BASE_COST: Record<CabinPieceKind, Record<string, number>> = {
  foundation:   { wood: 4 },
  pillar:       { wood: 2 },
  wall_solid:   { wood: 4 },
  wall_window:  { wood: 4 },
  wall_doorway: { wood: 3 },
  door:         { wood: 2, iron_ingot: 1 },
  floor:        { wood: 3 },
  ceiling:      { wood: 4 },
  roof_slope:   { wood: 5 },
  roof_peak:    { wood: 3 },
  stairs:       { wood: 4 },
  gate:         { wood: 4, iron_ingot: 2 },
  ladder:       { wood: 2 },
};

/**
 * Base HP per piece kind at tier T0 (`rough_log`). Per-tier multiplier in
 * `CABIN_TIER_HP_MULT` scales this up. Phase 4 damage events use the resulting `maxHp`.
 */
const CABIN_PIECE_BASE_HP: Record<CabinPieceKind, number> = {
  foundation: 100,
  pillar: 80,
  wall_solid: 80,
  wall_window: 70,
  wall_doorway: 60,
  door: 50,
  floor: 60,
  ceiling: 70,
  roof_slope: 90,
  roof_peak: 80,
  stairs: 60,
  gate: 100,
  ladder: 40,
};

/** Per-tier wood cost multiplier; T2+ also adds 1 metal ingot of the matching tier. */
const CABIN_TIER_WOOD_MULT: Record<CabinMaterialTier, number> = {
  rough_log: 1.0,
  oak: 1.0,
  copper_band: 1.5,
  bronze_band: 1.6,
  silver_band: 1.8,
  gold_band: 2.0,
  platinum_band: 2.2,
};

/** Per-tier HP multiplier — strength scales geometrically up the metal-band tiers. */
const CABIN_TIER_HP_MULT: Record<CabinMaterialTier, number> = {
  rough_log: 1.0,
  oak: 1.4,
  copper_band: 2.0,
  bronze_band: 2.8,
  silver_band: 4.0,
  gold_band: 5.5,
  platinum_band: 8.0,
};

/** Map a metal-band tier to the inventory ingot key it consumes (T0/T1 = no ingot). */
const CABIN_TIER_INGOT: Partial<Record<CabinMaterialTier, string>> = {
  copper_band: 'copper_ingot',
  bronze_band: 'bronze_ingot',
  silver_band: 'silver_ingot',
  gold_band: 'gold_ingot',
  platinum_band: 'platinum_ingot',
};

/**
 * Material cost to place a piece of `kind` at material `tier`. Returns a fresh
 * `Record<string, number>` ready to feed `hasItems` / inventory decrement. Wood is
 * always required; metal ingot is added for T2+ tiers.
 */
export function cabinPieceCost(kind: CabinPieceKind, tier: CabinMaterialTier): Record<string, number> {
  const base = CABIN_PIECE_BASE_COST[kind];
  const woodMult = CABIN_TIER_WOOD_MULT[tier];
  const cost: Record<string, number> = {};
  for (const [k, q] of Object.entries(base)) {
    /* Round up so a fractional cost like 4 × 1.5 = 6 stays an integer; tighter rounding
     * later won't break saves because the cost is recomputed each placement, never
     * stored. */
    cost[k] = Math.ceil(q * (k === 'wood' ? woodMult : 1));
  }
  const ingot = CABIN_TIER_INGOT[tier];
  if (ingot) {
    cost[ingot] = (cost[ingot] ?? 0) + 1;
  }
  return cost;
}

/**
 * Max HP for a piece of `kind` at material `tier`. The result is FROZEN into the
 * placed piece at place-time so a future tier-balance retune doesn't break existing
 * saves (existing pieces keep their original maxHp; only newly-placed pieces see the
 * new numbers).
 */
export function cabinPieceMaxHp(kind: CabinPieceKind, tier: CabinMaterialTier): number {
  return Math.round(CABIN_PIECE_BASE_HP[kind] * CABIN_TIER_HP_MULT[tier]);
}

/* ============================================================================
 * Awakened-mode craft-station placement helpers
 * (Phase 2 of base-building — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §9)
 *
 * Cost numbers MIRROR the dream-mode recipes in `data/content.ts`
 * (`r_campfire`, `r_workbench`, `r_forge`, `r_kitchen`) so a player who's used
 * to dream-mode crafting recognises the cost when they open Build mode.
 * Provisional HP — Phase 4 raid balance retunes once mob damage exists.
 * ============================================================================ */

const CRAFT_STATION_BASE_COST: Record<PlacedCraftStationKind, Record<string, number>> = {
  campfire:  { stone: 5, wood: 8, fiber: 3 },
  workbench: { wood: 25, stone: 10, fiber: 8 },
  forge:     { stone: 20, iron_ore: 14, coal: 6 },
  kitchen:   { wood: 18, stone: 12, fiber: 6 },
};

const CRAFT_STATION_BASE_HP: Record<PlacedCraftStationKind, number> = {
  campfire:  60,
  workbench: 120,
  forge:     180,
  kitchen:   100,
};

/**
 * Material cost to place one craft station of `kind`. Returns a fresh record so
 * callers can mutate without poisoning the constant.
 */
export function craftStationCost(kind: PlacedCraftStationKind): Record<string, number> {
  return { ...CRAFT_STATION_BASE_COST[kind] };
}

/**
 * Max HP for a station of `kind`. Frozen into the placed station at place-time
 * so a future balance retune doesn't break existing saves.
 */
export function craftStationMaxHp(kind: PlacedCraftStationKind): number {
  return CRAFT_STATION_BASE_HP[kind];
}

/* ============================================================================
 * Awakened-mode mob stats (Phase 1.5 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §13.4)
 *
 * Provisional balance — Phase 4 polish pass tunes once raids land. Numbers chosen
 * so a fresh awakened player can survive a few rats with bare-hand combat, struggle
 * with wolves, and need real gear / magic to handle wanderers.
 * ============================================================================ */

export interface AwakenedMobStats {
  maxHp: number;
  damage: number;
  /** Aggro range — chase the player when within this distance. */
  aggroRange: number;
  /** Melee range — apply damage when within this distance. */
  meleeRange: number;
  /** Walk speed (world units / sec). */
  walkSpeed: number;
  /** Attack cooldown (ms) between successive damage applications. */
  attackCooldownMs: number;
}

/* AGGRO RANGE TUNING (post-Phase-1.5 player-feedback pass):
 *
 * Old values were 18-22 m which felt like "the wolf saw me from across the field" —
 * mobs would aggro the moment a player crossed half the visible map and there was no
 * sense of "I have to actually be close to be a threat". Tightened to:
 *   - rat 8 m  : opportunistic small predator; only engages when the player is right
 *                next to its territory.
 *   - wolf 14 m : proper wolf engagement distance — far enough to feel ominous when
 *                they start charging, close enough that the player has clear control
 *                over whether to engage.
 *   - wanderer 12 m : human raider with a melee weapon; engages when the player walks
 *                into their personal space, not at horizon. */
export const AWAKENED_MOB_STATS: Record<AwakenedMobKind, AwakenedMobStats> = {
  rat:      { maxHp: 12,  damage: 3,  aggroRange: 8,  meleeRange: 1.0, walkSpeed: 4.5, attackCooldownMs: 900 },
  wolf:     { maxHp: 28,  damage: 6,  aggroRange: 14, meleeRange: 1.4, walkSpeed: 5.5, attackCooldownMs: 1100 },
  wanderer: { maxHp: 55,  damage: 11, aggroRange: 12, meleeRange: 1.6, walkSpeed: 3.5, attackCooldownMs: 1500 },
};

function addInv(inv: Record<string, number>, delta: Record<string, number>): void {
  for (const [k, v] of Object.entries(delta)) {
    inv[k] = (inv[k] ?? 0) + v;
  }
}

function spendInv(inv: Record<string, number>, cost: Record<string, number>): boolean {
  if (!hasItems(inv, cost)) return false;
  for (const [k, v] of Object.entries(cost)) {
    inv[k] = (inv[k] ?? 0) - v;
  }
  return true;
}

/**
 * Deck unlock costs may list structures/tools as proof you built them — those ids are NOT removed.
 * Only consumables (stone, wood, ore, etc.) are spent. Spoilage does not touch structures.
 */
const CARD_UNLOCK_PRESERVE_IDS = new Set<string>([
  'campfire',
  'workbench',
  'forge',
  'kitchen',
  'garden_plot',
  'well',
  'food_forest',
  'cooler',
  'repair_bench',
  'axe',
  'pickaxe',
  'iron_axe',
  'iron_pickaxe',
  'iron_sword',
  'wooden_shield',
  'copper_pickaxe',
  'bronze_pickaxe',
  'brass_pickaxe',
  'steel_pickaxe',
  'silver_pickaxe',
  'gold_pickaxe',
  'platinum_pickaxe',
  'copper_axe',
  'bronze_axe',
  'brass_axe',
  'steel_axe',
  'bronze_sword',
  'steel_sword',
  'silver_sword',
  'gold_sword',
  'platinum_sword',
]);

function spendInvForCardUnlock(inv: Record<string, number>, cost: Record<string, number>): boolean {
  const spend: Record<string, number> = {};
  for (const [k, v] of Object.entries(cost)) {
    if (CARD_UNLOCK_PRESERVE_IDS.has(k)) continue;
    spend[k] = v;
  }
  if (Object.keys(spend).length === 0) return true;
  return spendInv(inv, spend);
}

function prerequisitesMet(card: CardDef, unlocked: Set<string>, inv: Record<string, number>): boolean {
  if (card.requiresCards) {
    for (const id of card.requiresCards) {
      if (!unlocked.has(id)) return false;
    }
  }
  if (card.requiresItems && !hasItems(inv, card.requiresItems)) return false;
  return true;
}

function recipeUnlocked(r: RecipeDef, unlocked: Set<string>, inv: Record<string, number>): boolean {
  if (r.requiresCards) {
    for (const id of r.requiresCards) {
      if (!unlocked.has(id)) return false;
    }
  }
  /* `requiresItems` gates a recipe behind owning a previous-tier item. Used by the crystal
   * staff/wand line so each tier's recipe appears only after the previous one has been
   * crafted (and is still in inventory). Phase D — `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §9. */
  if (r.requiresItems) {
    if (!hasItems(inv, r.requiresItems)) return false;
  }
  return true;
}

function effectiveStations(state: GameState): Set<CraftStation> {
  const s = new Set<CraftStation>(state.stations);
  if ((state.inventory.campfire ?? 0) > 0) s.add('campfire');
  if ((state.inventory.workbench ?? 0) > 0) s.add('workbench');
  if ((state.inventory.forge ?? 0) > 0) s.add('forge');
  if ((state.inventory.kitchen ?? 0) > 0) s.add('kitchen');
  for (const cid of state.unlockedCardIds) {
    const c = cardById.get(cid);
    if (c?.unlocksStation) s.add(c.unlocksStation);
  }
  return s;
}

function isDurabilityItem(id: string): boolean {
  return (DURABILITY_ITEM_IDS as readonly string[]).includes(id);
}

function ensureDurability(state: GameState, itemId: string): void {
  if (!isDurabilityItem(itemId)) return;
  if (state.toolDurability[itemId] === undefined) state.toolDurability[itemId] = 100;
}

/** True if localStorage has a persisted run (used by start menu Continue). */
export function hasIdleCraftSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) != null;
  } catch {
    return false;
  }
}

export class GameStore {
  private state: GameState;
  private listeners: (() => void)[] = [];
  /** From latest room snapshot: you are out of 3v3 / PvP bracket until a new match. */
  private onlineSelfEliminated = false;
  /** Host proposed a PvP engagement; lobby majority vote in progress. */
  private pvpVotePrompt: { proposalId: string; proposerName: string } | null = null;
  /** Hunter1v1: you are the invitee (Accept / Decline). */
  private pvpDuelInvitePrompt: {
    proposalId: string;
    proposerName: string;
    proposerSessionId: string;
  } | null = null;
  /** Latest `yourSessionId` from room snapshots (PvP defeat relay). */
  private lastYourSessionId: string | null = null;
  /** All session ids in the last room snapshot (voice mesh). */
  private lastRoomPeerIds: string[] = [];
  /** Latest roster from room snapshots (presence labels, Hunter target). */
  private lastRoomPlayers: RoomPlayerPublic[] = [];
  /** From snapshot — who sits dock-left in Hunter 1v1 shared view. */
  private lastRoomHostSessionId: string | null = null;
  /** Ignore stale co-op ledger packets (server `rev`). */
  private lastCoopRevApplied = -1;
  /** Remote presence by session (active phase). */
  private remotePresence = new Map<string, RemotePresenceEntry>();
  private lastPvpStrikeSeqSeen = 0;
  /**
   * In-flight manual-gather session. **Runtime-only** — deliberately not persisted in
   * `GameState` because the dock animation it pairs with cannot survive a page reload, and
   * we do not want a half-completed gather to grant on next launch from a stale timer.
   *
   * Lives on the store (not in a `setTimeout` closure inside the gather page handler) so
   * the lifecycle survives tab switches, return-to-title cleanup goes through one path, and
   * every page that subscribes to the store can reflect "currently gathering" busy state
   * without depending on the gather-page's DOM still existing.
   *
   * Tick advances the session: at `startedAtMs + sfxDelayMs` plays the world SFX (matching
   * the original "play sfx when avatar reaches the work phase" timing), and at
   * `startedAtMs + durationMs` runs the loot grant via `performGather` and clears the field.
   */
  private activeGather: {
    actionId: string;
    harvestSlot: number;
    startedAtMs: number;
    durationMs: number;
    sfxDelayMs: number;
    sfxFired: boolean;
  } | null = null;

  constructor() {
    this.state = loadState() ?? createInitialState();
  }

  getOnlineSelfEliminated(): boolean {
    return this.onlineSelfEliminated;
  }

  getPvpVotePrompt(): { proposalId: string; proposerName: string } | null {
    return this.pvpVotePrompt;
  }

  getYourRoomSessionId(): string | null {
    return this.lastYourSessionId;
  }

  getRoomPeerSessionIds(): string[] {
    return this.lastRoomPeerIds;
  }

  getLastRoomPlayers(): readonly RoomPlayerPublic[] {
    return this.lastRoomPlayers;
  }

  /** Room host session id for canonical dock layout (falls back to roster if unset). */
  getRoomHostSessionId(): string | null {
    return this.lastRoomHostSessionId;
  }

  dismissPvpVotePrompt(): void {
    this.pvpVotePrompt = null;
    this.emit();
  }

  getPvpDuelInvitePrompt(): typeof this.pvpDuelInvitePrompt {
    return this.pvpDuelInvitePrompt;
  }

  dismissPvpDuelInvitePrompt(): void {
    this.pvpDuelInvitePrompt = null;
    this.emit();
  }

  getRemotePresenceSnapshot(): ReadonlyMap<string, RemotePresenceEntry> {
    return this.remotePresence;
  }

  /** Room hub → co-op stash, PvP assignments, hits, votes (mountApp subscribes). */
  ingestRoomHubEvent(ev: RoomHubEvent): void {
    switch (ev.type) {
      case 'snapshot': {
        this.applyRoomSnapshotMeta(ev.room);
        break;
      }
      case 'coop_inventory': {
        if (this.state.gameMode === 'coop' && this.state.onlineSession) {
          this.applyCoopAuthority(ev.inventory, ev.currency, true, ev.rev);
        }
        break;
      }
      case 'pvp_assigned': {
        if (!this.state.onlineSession || ev.rivalSessionId.length === 0) break;
        this.state.onlineSession = {
          ...this.state.onlineSession,
          pvpRival: {
            sessionId: ev.rivalSessionId,
            displayName: ev.rivalName,
            characterPresetId: ev.rivalPreset,
            maxHp: ev.maxHp,
          },
        };
        this.emit();
        try {
          window.dispatchEvent(new CustomEvent('idlecraft-open-battle-tab'));
        } catch {
          /* no window */
        }
        break;
      }
      case 'pvp_vote_start': {
        if (!ev.proposalId) break;
        this.pvpVotePrompt = { proposalId: ev.proposalId, proposerName: ev.proposerName };
        this.emit();
        break;
      }
      case 'pvp_vote_result': {
        this.pvpVotePrompt = null;
        this.emit();
        break;
      }
      case 'pvp_hit': {
        this.applyPvpHitNetwork(ev);
        break;
      }
      case 'presence_update': {
        if (!this.state.onlineSession || ev.sessionId === this.lastYourSessionId) break;
        const realm = ev.realm === 'awakened' ? 'awakened' : 'deck';
        this.remotePresence.set(ev.sessionId, {
          page: ev.page,
          gatherKey: ev.gatherKey,
          progress01: ev.progress01,
          seq: ev.seq,
          realm,
          wx: realm === 'awakened' ? (ev.wx ?? null) : null,
          wy: realm === 'awakened' ? (ev.wy ?? null) : null,
          wz: realm === 'awakened' ? (ev.wz ?? null) : null,
          wyaw: realm === 'awakened' ? (ev.wyaw ?? null) : null,
        });
        this.emit();
        break;
      }
      case 'pvp_duel_invite': {
        this.pvpDuelInvitePrompt = {
          proposalId: ev.proposalId,
          proposerName: ev.proposerName,
          proposerSessionId: ev.proposerSessionId,
        };
        this.emit();
        break;
      }
      case 'pvp_duel_pending':
      case 'pvp_duel_declined':
      case 'pvp_duel_expired': {
        /* UI can show toasts later; invitee modal cleared server-side. */
        if (ev.type === 'pvp_duel_declined' || ev.type === 'pvp_duel_expired') {
          this.pvpDuelInvitePrompt = null;
        }
        this.emit();
        break;
      }
      case 'pvp_rival_defeated': {
        this.applyPvpRivalDefeatedNetwork(ev.loserSessionId);
        break;
      }
      default:
        break;
    }
  }

  private applyRoomSnapshotMeta(room: RoomSnapshot): void {
    this.lastYourSessionId = room.yourSessionId || null;
    this.lastRoomPeerIds = room.players.map((p) => p.sessionId);
    this.lastRoomPlayers = room.players.slice();
    const fromSnap =
      typeof room.hostSessionId === 'string' && room.hostSessionId.length > 0
        ? room.hostSessionId
        : null;
    this.lastRoomHostSessionId =
      fromSnap ?? room.players.find((p) => p.isHost)?.sessionId ?? null;
    if (room.phase !== 'active') this.remotePresence.clear();
    const you = room.players.find((p) => p.sessionId === room.yourSessionId);
    this.onlineSelfEliminated = !!you?.eliminated;
    if (
      room.gameMode === 'coop' &&
      room.phase === 'active' &&
      room.coop &&
      this.state.gameMode === 'coop' &&
      this.state.onlineSession?.roomId === room.id
    ) {
      this.applyCoopAuthority(room.coop.inventory, room.coop.currency, false, room.coop.rev);
    }
    this.emit();
  }

  private applyCoopAuthority(
    inv: Record<string, number>,
    currency: number,
    shouldEmit = true,
    rev?: number,
  ): void {
    if (rev !== undefined && rev <= this.lastCoopRevApplied) return;
    if (rev !== undefined) this.lastCoopRevApplied = rev;
    this.state.inventory = { ...inv };
    this.state.currency = Math.max(0, currency);
    if (shouldEmit) this.emit();
  }

  private applyPvpHitNetwork(ev: {
    fromSessionId: string;
    toSessionId: string;
    damage: number;
    cardName: string;
    strikeSeq: number;
  }): void {
    const you = this.lastYourSessionId;
    if (ev.strikeSeq > 0 && ev.strikeSeq <= this.lastPvpStrikeSeqSeen) return;
    if (ev.strikeSeq > 0) this.lastPvpStrikeSeqSeen = ev.strikeSeq;

    if (you && ev.toSessionId !== you) {
      try {
        window.dispatchEvent(
          new CustomEvent('pvp-arena-strike', {
            detail: {
              fromSessionId: ev.fromSessionId,
              toSessionId: ev.toSessionId,
              damage: ev.damage,
              cardName: ev.cardName,
              strikeSeq: ev.strikeSeq,
            },
          }),
        );
      } catch {
        /* no window */
      }
      return;
    }

    this.applyPvpIncomingHit(ev.damage, ev.cardName);
  }

  private applyPvpIncomingHit(damage: number, cardName: string): void {
    const b = this.state.battle;
    /* Network strikes arrive on the defender while their local turn may still be `player` — do not require `enemy`. */
    if (!b || b.mode !== 'pvp' || (b.turn !== 'player' && b.turn !== 'enemy')) return;
    const mit = this.getArmorMitigation();
    const raw = Math.max(0, damage);
    let incoming = raw;
    let ward = b.spellWard ?? 0;
    let wardUsed = 0;
    if (ward > 0) {
      const absorbed = Math.min(ward, incoming);
      wardUsed = absorbed;
      ward -= absorbed;
      incoming -= absorbed;
      b.spellWard = ward;
    }
    const reduced =
      incoming <= 0
        ? 0
        : Math.max(1, Math.floor(incoming * (1 - Math.min(0.45, mit * 0.025))));
    this.state.playerHp -= reduced;
    if (this.state.equipment.shield === 'wooden_shield') this.applyToolWear('wooden_shield', 1.2);
    const wardNote = wardUsed > 0 ? `, −${wardUsed} ward` : '';
    const cn = cardName ? ` (${cardName})` : '';
    if (reduced <= 0) {
      b.log.push(
        `${b.enemy.name} played${cn || ' a card'} — no damage (${mit} armor${wardNote}). You are at ${Math.max(0, Math.ceil(this.state.playerHp))} / ${this.state.playerMaxHp} HP.`,
      );
    } else {
      b.log.push(
        `${b.enemy.name} hits you for ${reduced}${cn} (${mit} armor${wardNote}). You are now at ${Math.max(0, Math.ceil(this.state.playerHp))} / ${this.state.playerMaxHp} HP.`,
      );
    }
    if (this.state.playerHp <= 0) {
      this.state.playerHp = 0;
      b.turn = 'defeat';
      b.pendingPermadeath = {
        headline: 'Defeated in PvP',
        body: `You were defeated by ${b.enemy.name}. In online duels you lose this run’s resources — stay in the lobby for a fresh camp or leave the session from the chat panel.`,
        pvpStayInLobby: !!this.state.onlineSession,
      };
      b.log.push('You collapse — the duel is over.');
      try {
        window.dispatchEvent(new CustomEvent('pvp-incoming-hit', { detail: { damage: reduced } }));
      } catch {
        /* no window */
      }
      this.emit();
      return;
    }
    b.turnNumber += 1;
    b.playerEnergy = Math.min(b.playerMaxEnergy, b.playerEnergy + 1);
    b.turn = 'player';
    try {
      window.dispatchEvent(new CustomEvent('pvp-incoming-hit', { detail: { damage: reduced } }));
    } catch {
      /* no window */
    }
    this.emit();
  }

  private applyPvpRivalDefeatedNetwork(loserSessionId: string): void {
    if (!loserSessionId || !this.lastYourSessionId) return;
    if (loserSessionId === this.lastYourSessionId) {
      const b = this.state.battle;
      if (b?.mode === 'pvp' && b.turn !== 'defeat' && b.turn !== 'victory') {
        this.state.playerHp = 0;
        b.turn = 'defeat';
        b.pendingPermadeath = {
          headline: 'Defeated in PvP',
          body: `Your rival landed the killing blow. You lose this run’s resources — respawn in the lobby or leave the session from the chat panel.`,
          pvpStayInLobby: !!this.state.onlineSession,
        };
        b.log.push('You collapse — the duel is over.');
        this.emit();
      }
      return;
    }
    const b = this.state.battle;
    const rival = this.state.onlineSession?.pvpRival;
    if (
      b &&
      b.mode === 'pvp' &&
      rival &&
      rival.sessionId === loserSessionId &&
      b.turn !== 'victory' &&
      b.turn !== 'defeat'
    ) {
      b.turn = 'victory';
      b.enemyHp = 0;
      b.log.push(`${b.enemy.name} is down — you win this duel.`);
      this.state.pveWave += 1;
      this.state.playerHp = Math.min(this.state.playerMaxHp, Math.max(1, Math.ceil(this.state.playerHp)));
      try {
        window.dispatchEvent(new CustomEvent('pvp-remote-victory'));
      } catch {
        /* no window */
      }
      this.emit();
    }
  }

  /** Reset run after PvP death but keep the same online lobby connection and session meta. */
  pvpDieResetStayInLobby(headline: string, body: string): void {
    const os = this.state.onlineSession;
    const mode = this.state.gameMode;
    const preset = this.state.characterPresetId;
    if (!os) {
      this.dieAndWipe(headline, body);
      return;
    }
    const prevTutorial = this.state.tutorial;
    setBattleMusicMode(false);
    this.state = createInitialState();
    this.state.tutorial = tutorialAfterPermadeathWipe(prevTutorial);
    this.state.gameMode = mode;
    this.state.characterPresetId = preset;
    this.state.onlineSession = {
      roomId: os.roomId,
      seed: os.seed,
      ...(os.team !== undefined ? { team: os.team } : {}),
      ...(os.partyRoster && os.partyRoster.length > 0 ? { partyRoster: [...os.partyRoster] } : {}),
      ...(os.pvpRival ? { pvpRival: { ...os.pvpRival } } : {}),
    };
    this.state.lastDeathHeadline = headline;
    this.state.lastDeathBody = body;
    saveState(this.state);
    this.emit();
  }

  setGameMode(mode: GameMode): void {
    this.state.gameMode = mode;
    this.emit();
  }

  setCharacterPreset(id: CharacterPresetId): void {
    this.state.characterPresetId = id;
    this.emit();
  }

  /**
   * Fresh expedition for an online-launched run: new camp, keeps mode + character, stores lobby room + seed.
   * Each player gets their own local run; seed keeps encounter order aligned for comparison / future sync.
   */
  beginOnlineSession(meta: OnlineSessionMeta): void {
    const mode = this.state.gameMode;
    const preset = this.state.characterPresetId;
    this.state = createInitialState();
    this.state.gameMode = mode;
    this.state.characterPresetId = preset;
    this.state.onlineSession = {
      roomId: meta.roomId,
      seed: meta.seed,
      ...(meta.sessionKind ? { sessionKind: meta.sessionKind } : {}),
      ...(meta.team !== undefined ? { team: meta.team } : {}),
      ...(meta.partyRoster && meta.partyRoster.length > 0 ? { partyRoster: [...meta.partyRoster] } : {}),
      ...(meta.pvpRival ? { pvpRival: { ...meta.pvpRival } } : {}),
    };
    if (meta.sessionKind === 'moba_match') {
      this.state.realmMode = 'awakened';
      this.state.tutorial = { version: 1, status: 'skipped', stepId: 'intro' };
    }
    this.lastCoopRevApplied = -1;
    this.remotePresence.clear();
    this.lastRoomPlayers = [];
    this.lastRoomHostSessionId = null;
    this.lastPvpStrikeSeqSeen = 0;
    this.pvpDuelInvitePrompt = null;
    this.emit();
  }

  /**
   * Local MOBA vertical slice: same awakened entry as `sessionKind: 'moba_match'` but
   * without a lobby session (practice / solo from the start flow).
   */
  beginSoloMobaMatch(): void {
    const preset = this.state.characterPresetId;
    this.state = createInitialState();
    this.state.gameMode = 'solo';
    this.state.characterPresetId = preset;
    this.state.realmMode = 'awakened';
    this.state.tutorial = { version: 1, status: 'skipped', stepId: 'intro' };
    this.lastCoopRevApplied = -1;
    this.remotePresence.clear();
    this.lastRoomPlayers = [];
    this.lastRoomHostSessionId = null;
    this.lastPvpStrikeSeqSeen = 0;
    this.pvpDuelInvitePrompt = null;
    this.emit();
  }

  /**
   * Title **Continue** path: older IDLE-shaped saves may still have `realmMode: 'deck'`.
   * MOBA always resumes into the awakened 3D shell.
   */
  resumeIntoMobaShell(): void {
    let changed = false;
    if (this.state.realmMode !== 'awakened') {
      this.state.realmMode = 'awakened';
      changed = true;
    }
    if (this.state.tutorial.status === 'not_started' || this.state.tutorial.status === 'active') {
      this.state.tutorial = { version: 1, status: 'skipped', stepId: 'intro' };
      changed = true;
    }
    if (changed) {
      saveState(this.state);
      this.emit();
    }
  }

  clearOnlineSession(): void {
    if (this.state.onlineSession == null) return;
    this.state.onlineSession = null;
    this.lastCoopRevApplied = -1;
    this.remotePresence.clear();
    this.lastRoomPlayers = [];
    this.lastRoomPeerIds = [];
    this.lastYourSessionId = null;
    this.lastRoomHostSessionId = null;
    this.lastPvpStrikeSeqSeen = 0;
    this.pvpDuelInvitePrompt = null;
    this.emit();
  }

  private helperIdleSlice(h: HelperDef): number {
    if (h.idleBonus !== undefined) return Math.max(0, h.idleBonus);
    return Math.max(0, h.speedMult - 1);
  }

  /** Combined multiplier applied to slotted idle automation outputs. */
  getIdleAutomationMult(): number {
    let idleBonusSum = 0;
    for (const hid of this.state.hiredHelperIds) {
      const h = helperById.get(hid);
      if (h) idleBonusSum += this.helperIdleSlice(h);
    }
    let m = 1 + Math.min(IDLE_HELPER_BONUS_CAP, idleBonusSum);
    /* Co-op caravan: modest idle bonus while in an online-launched co-op session */
    if (this.state.gameMode === 'coop' && this.state.onlineSession) {
      m *= 1.08;
    }
    return m;
  }

  getState(): GameState {
    return cloneState(this.state);
  }

  /**
   * Returns the LIVE state object — NO defensive clone. Read-only by
   * convention; the `Readonly<GameState>` return type makes accidental
   * mutation a TypeScript compile error.
   *
   * Use this for any read-only inspection (hot UI code, frame-loop
   * branches, gates that decide whether to fire an action). Use
   * `getState()` only when the caller genuinely needs a defensive
   * clone they can mutate locally.
   *
   * Why this exists: `getState()` does
   * `JSON.parse(JSON.stringify(state))` on every call (1-10 ms per
   * call depending on save size). `mountApp.ts` calls `getState()`
   * 37 times during boot — switching the read-only ones to
   * `getStateRef()` removes 100-500+ ms of cumulative JSON tax from
   * the post-cutscene mountApp body.
   *
   * The frozen return type does NOT freeze the object at runtime
   * (would break too much existing code). It's a compile-time guard
   * only — production runtime behavior is identical to returning
   * `this.state` directly. ANY mutation here corrupts shared state;
   * the type system is the safety net.
   */
  getStateRef(): Readonly<GameState> {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private emit(): void {
    saveState(this.state);
    for (const f of this.listeners) f();
  }

  private tickSaveMs = 0;

  /* === 2026-04-20 Tier D — per-frame allocation cleanup ===
   *
   * `tick()` runs every animation frame from `mountApp`'s `frame()` loop
   * (60 Hz typical). Before this pass it allocated three things every call:
   *   1. `const rates: Record<string, number> = {}` — fresh empty object.
   *   2. `const unlocked = new Set(s.unlockedCardIds)` — fresh Set with
   *      every unlocked card id (typically 5-50 entries).
   *   3. Multiple `Object.entries(...)` calls inside loops (each allocates
   *      an array of [key, value] tuples).
   *
   * At 60 Hz with 4-8 idle slots + 0-6 helpers that's ~600-1200 small
   * allocations per second feeding the GC. Not catastrophic but a
   * measurable contributor to the "occasional pause" feel during long
   * play sessions (V8 minor GC pauses cluster around the 10 ms mark
   * when allocation rate is high).
   *
   * Fix:
   *   - `_scratchRates` is reused across ticks; cleared via `for (const
   *     k in)` (preserves V8 hidden class shape vs reassignment) at the
   *     top of `tick()`. Stale-zero entries are skipped in the apply
   *     loop (`if (r === 0) continue`) so they don't pollute inventory
   *     with explicit-zero keys.
   *   - `_cachedUnlockedSet` is rebuilt only when the underlying array
   *     reference OR length changes (catches the two real mutation
   *     shapes: `state = createInitialState()` reassigns the array ref;
   *     `unlockedCardIds.push(...)` changes length). No instrumentation
   *     of mutation sites needed — the cache invalidates automatically.
   *   - All hot-loop `Object.entries(staticDef)` were swapped to
   *     `for (const k in staticDef)` to skip the [key,value][] alloc.
   *     Safe because automation outputs / passiveGather / upkeepPerMinute
   *     are plain data records with no inherited keys.
   *
   * Net: 0 allocations in the steady-state `tick()` hot path. */
  private _scratchRates: Record<string, number> = {};
  private _cachedUnlockedSet: Set<string> = new Set();
  private _cachedUnlockedRef: readonly string[] | null = null;
  private _cachedUnlockedLen: number = -1;

  /**
   * Returns a cached `Set<string>` mirror of `state.unlockedCardIds`, rebuilt
   * lazily only when the underlying array reference or length changes.
   *
   * Same shape every caller already used (`new Set(state.unlockedCardIds)`),
   * just allocation-free in the steady-state hot path.
   */
  private getUnlockedCardSet(): ReadonlySet<string> {
    const ids = this.state.unlockedCardIds;
    if (this._cachedUnlockedRef === ids && this._cachedUnlockedLen === ids.length) {
      return this._cachedUnlockedSet;
    }
    /* Reuse the existing Set instance — `clear()` is O(1) on V8 and avoids
     * rebuilding the internal hash table from scratch. Listeners that captured
     * the Set reference (none today, but defensive) keep seeing live data. */
    this._cachedUnlockedSet.clear();
    for (let i = 0; i < ids.length; i++) {
      this._cachedUnlockedSet.add(ids[i]!);
    }
    this._cachedUnlockedRef = ids;
    this._cachedUnlockedLen = ids.length;
    return this._cachedUnlockedSet;
  }

  getWeaponDamageBonus(): number {
    const w = this.state.equipment.weapon;
    return WEAPON_DAMAGE_BONUS[w ?? ''] ?? 0;
  }

  getArmorMitigation(): number {
    let arm = 0;
    if (this.state.equipment.shield === 'wooden_shield') arm += 3;
    return Math.min(12, arm);
  }

  getToolDurabilityPercent(itemId: string): number {
    if (!isDurabilityItem(itemId)) return 100;
    return this.state.toolDurability[itemId] ?? 100;
  }

  /** Base maxMana from state plus bonuses from unlocked magic cards + harvested crystals. */
  getEffectiveMaxMana(): number {
    let bonus = 0;
    /* Tier D — `tick()` calls this every frame for mana-regen math; the
     * cached unlocked-set avoids per-frame `new Set(...)` alloc. */
    const u = this.getUnlockedCardSet();
    for (const c of cardDefs) {
      if (!u.has(c.id)) continue;
      bonus += c.maxManaBonus ?? 0;
    }
    /* Phase D — magic-crystal harvest grows the spell pool. +0.5 per crystal so a player
     * who harvests ~20 crystals doubles their starting max mana. Locked in
     * `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §9. */
    bonus += this.state.magicCrystalsHarvested * 0.5;
    return Math.max(6, this.state.maxMana + bonus);
  }

  /** Extra mana / sec from unlocked magic cards (added to a small base regen in tick). */
  getMagicManaRegenBonus(): number {
    let bonus = 0;
    /* Tier D — `tick()` calls this every frame; the cached unlocked-set
     * avoids per-frame `new Set(...)` alloc. */
    const u = this.getUnlockedCardSet();
    for (const c of cardDefs) {
      if (!u.has(c.id)) continue;
      bonus += c.manaRegenBonus ?? 0;
    }
    return bonus;
  }

  /** Arcane helpers add flat damage to spell attacks only. */
  getArcaneSpellDamageBonus(): number {
    let n = 0;
    for (const hid of this.state.hiredHelperIds) {
      const h = helperById.get(hid);
      if (h?.role !== 'arcane') continue;
      n += h?.battleAssist?.damageBonus ?? 0;
    }
    return n;
  }

  /**
   * Picks the nearest harvest slot with a ready node for this action (same XZ ring as the dock preview).
   * Returns null when every node for that kind is depleted; otherwise slot index 0..N-1.
   */
  reserveHarvestSlot(
    actionId: string,
    avatarX: number,
    avatarZ: number,
    waterBank: { x: number; z: number },
  ): number | null {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return 0;
    const now = Date.now();
    const patch = this.state.harvestPatches[kind];
    if (!patch?.nodes.length || patch.sealed) return null;
    const slots = allHarvestSlotPositions(waterBank)[kind];
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < patch.nodes.length; i++) {
      const n = patch.nodes[i]!;
      if (!harvestNodeReady(n, now)) continue;
      const p = slots[i] ?? slots[0]!;
      const d = (p.x - avatarX) ** 2 + (p.z - avatarZ) ** 2;
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI < 0 ? null : bestI;
  }

  /** True when at least one gather node is ready for this action (or action is not patch-based). */
  hasHarvestSlotAvailable(actionId: string): boolean {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return true;
    const patch = this.state.harvestPatches[kind];
    if (!patch?.nodes?.length || patch.sealed) return false;
    const now = Date.now();
    return patch.nodes.some((n) => harvestNodeReady(n, now));
  }

  /** True when this gather action’s vein is permanently exhausted for the current expedition. */
  isHarvestVeinSealedForAction(actionId: string): boolean {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return false;
    return !!this.state.harvestPatches[kind]?.sealed;
  }

  /** Spend coin to raise a mastery tier for one vein branch (travel / yield / regrowth). */
  upgradeHarvestMastery(kind: HarvestNodeKind, branch: MasteryBranch): boolean {
    const m = this.state.harvestMastery[kind];
    if (!m) return false;
    const cur = m[branch];
    if (cur >= HARVEST_MASTERY_MAX_TIER) return false;
    const cost = masteryUpgradeCost(branch, cur);
    if (!Number.isFinite(cost) || this.state.currency < cost) return false;
    this.state.currency -= cost;
    m[branch] = cur + 1;
    this.emit();
    return true;
  }

  private getHarvestYieldMultiplierForAction(actionId: string): number {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return 1;
    const t = this.state.harvestMastery[kind]?.yield ?? 0;
    return harvestYieldMultiplier(t);
  }

  private applyVeinStrainAfterGather(kind: HarvestNodeKind): void {
    const patch = this.state.harvestPatches[kind];
    if (!patch || patch.sealed) return;
    const m = this.state.harvestMastery[kind] ?? { travel: 0, yield: 0, regrowth: 0 };
    const gain = veinStrainPerGather(m.travel, m.regrowth);
    const next = (patch.strain ?? 0) + gain;
    patch.strain = next;
    if (next >= SEAL_STRAIN_CAP) {
      patch.sealed = true;
      for (const n of patch.nodes) {
        n.depleted = true;
        n.respawnAtMs = 0;
      }
    }
  }

  private applyHarvestDepletion(actionId: string, slot?: number): void {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return;
    const patch = this.state.harvestPatches[kind];
    if (!patch?.nodes.length || patch.sealed) return;
    const i = Math.max(0, Math.min(patch.nodes.length - 1, slot ?? 0));
    const node = patch.nodes[i]!;
    const now = Date.now();
    if (!harvestNodeReady(node, now)) return;
    node.depleted = true;
    const regTier = this.state.harvestMastery[kind]?.regrowth ?? 0;
    node.respawnAtMs = now + HARVEST_RESPAWN_MS[kind] * regrowthTimeMultiplier(regTier);
    this.applyVeinStrainAfterGather(kind);
  }

  private applyHarvestRespawns(): boolean {
    const now = Date.now();
    const patches = this.state.harvestPatches;
    if (!patches) return false;
    let changed = false;
    for (const patch of Object.values(patches)) {
      if (patch.sealed) continue;
      for (const n of patch.nodes) {
        if (n.depleted && n.respawnAtMs > 0 && now >= n.respawnAtMs) {
          n.depleted = false;
          n.respawnAtMs = 0;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Grouped gather UI: stone / iron / coal are separate buttons; locked rows stay visible with reasons. */
  listGatherActionGroups(): GatherActionGroup[] {
    const s = this.state;
    const pick = this.effectivePickId();
    const u = new Set(s.unlockedCardIds);
    const alloyOres = u.has('c_card_alloy_crucible');
    const preciousOres = u.has('c_card_precious_arc');
    const hasCraftedPick = pick !== null;
    const m = pick ? this.pickTierMult() : 1;
    const ironBase = 0.22 * MANUAL_GATHER_YIELD_MULT;
    const coalBase = 0.26 * MANUAL_GATHER_YIELD_MULT;
    const ironPick = ironBase * m;
    const coalPick = coalBase * m;
    const oreCoalLockedDetail =
      'Locked: craft a pick at the workbench — unlock Pick techniques in Decks, then craft a stone pick (or better).';
    const depletedDetail = 'Nearby sources depleted — recovering soon.';
    const veinExhaustedDetail =
      'Vein exhausted for this expedition — a new camp after permadeath restores these nodes.';
    const harvestOk = (id: string) => this.hasHarvestSlotAvailable(id);
    const harvestDetail = (id: string, okDetail: string, ...gates: { ok: boolean; text: string }[]) => {
      for (const g of gates) {
        if (!g.ok) return g.text;
      }
      if (this.isHarvestVeinSealedForAction(id)) return veinExhaustedDetail;
      if (!harvestOk(id)) return depletedDetail;
      return okDetail;
    };

    const minerals: GatherActionGroup['actions'] = [
      {
        id: 'stone',
        title: 'Gather stone',
        enabled: harvestOk('stone'),
        detail: harvestDetail(
          'stone',
          `+${this.getStoneYield().toFixed(2)} stone${pick ? ' — pick tier boosts yield' : ' — no pick: low; add a pick for much more'}`,
        ),
      },
      {
        id: 'mine_iron_ore',
        title: 'Gather iron ore',
        enabled: hasCraftedPick && harvestOk('mine_iron_ore'),
        detail: harvestDetail('mine_iron_ore', `+${ironPick.toFixed(2)} iron ore (pick ×${m.toFixed(2)})`, {
          ok: hasCraftedPick,
          text: oreCoalLockedDetail,
        }),
      },
      {
        id: 'mine_coal',
        title: 'Gather coal',
        enabled: hasCraftedPick && harvestOk('mine_coal'),
        detail: harvestDetail('mine_coal', `+${coalPick.toFixed(2)} coal (pick ×${m.toFixed(2)})`, {
          ok: hasCraftedPick,
          text: oreCoalLockedDetail,
        }),
      },
      {
        id: 'mine_copper_ore',
        title: 'Gather copper ore',
        enabled: alloyOres && harvestOk('mine_copper_ore'),
        detail: harvestDetail(
          'mine_copper_ore',
          pick
            ? `+${(0.2 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} copper (pick ×${m.toFixed(2)}) — hands +${(0.2 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)}`
            : `+${(0.2 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} copper (hands) — pick for ~${(1 / ORE_BARE_HANDS_MULT).toFixed(1)}×+`,
          { ok: alloyOres, text: `Locked: unlock Alloy crucible primer (Decks).` },
        ),
      },
      {
        id: 'mine_tin_ore',
        title: 'Gather tin ore',
        enabled: alloyOres && harvestOk('mine_tin_ore'),
        detail: harvestDetail(
          'mine_tin_ore',
          pick
            ? `+${(0.19 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} tin (pick ×${m.toFixed(2)})`
            : `+${(0.19 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} tin (hands)`,
          { ok: alloyOres, text: `Locked: unlock Alloy crucible primer (Decks).` },
        ),
      },
      {
        id: 'mine_zinc_ore',
        title: 'Gather zinc ore',
        enabled: alloyOres && harvestOk('mine_zinc_ore'),
        detail: harvestDetail(
          'mine_zinc_ore',
          pick
            ? `+${(0.18 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} zinc (pick ×${m.toFixed(2)})`
            : `+${(0.18 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} zinc (hands)`,
          { ok: alloyOres, text: `Locked: unlock Alloy crucible primer (Decks).` },
        ),
      },
      {
        id: 'mine_silver_ore',
        title: 'Gather silver ore',
        enabled: preciousOres && harvestOk('mine_silver_ore'),
        detail: harvestDetail(
          'mine_silver_ore',
          pick
            ? `+${(0.15 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} silver (pick ×${m.toFixed(2)})`
            : `+${(0.15 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} silver (hands)`,
          { ok: preciousOres, text: `Locked: unlock Crown deep vein (Decks).` },
        ),
      },
      {
        id: 'mine_gold_ore',
        title: 'Gather gold ore',
        enabled: preciousOres && harvestOk('mine_gold_ore'),
        detail: harvestDetail(
          'mine_gold_ore',
          pick
            ? `+${(0.12 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} gold (pick ×${m.toFixed(2)})`
            : `+${(0.12 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} gold (hands)`,
          { ok: preciousOres, text: `Locked: unlock Crown deep vein (Decks).` },
        ),
      },
      {
        id: 'mine_platinum_ore',
        title: 'Gather platinum ore',
        enabled: preciousOres && harvestOk('mine_platinum_ore'),
        detail: harvestDetail(
          'mine_platinum_ore',
          pick
            ? `+${(0.09 * m * MANUAL_GATHER_YIELD_MULT).toFixed(2)} platinum (pick ×${m.toFixed(2)})`
            : `+${(0.09 * ORE_BARE_HANDS_MULT * MANUAL_GATHER_YIELD_MULT).toFixed(2)} platinum (hands)`,
          { ok: preciousOres, text: `Locked: unlock Crown deep vein (Decks).` },
        ),
      },
    ];

    const woodPlant: GatherActionGroup['actions'] = [
      {
        id: 'wood',
        title: 'Gather wood',
        enabled: harvestOk('wood'),
        detail: harvestDetail(
          'wood',
          `+${this.getWoodYield().toFixed(2)} wood — equip stone axe or iron axe for more`,
        ),
      },
      {
        id: 'fiber',
        title: 'Gather fiber',
        enabled: harvestOk('fiber'),
        detail: harvestDetail(
          'fiber',
          `+${this.getFiberYield().toFixed(2)} fiber — small bonus if a chopping tool is equipped`,
        ),
      },
    ];

    const food: GatherActionGroup['actions'] = [
      {
        id: 'water',
        title: 'Gather water',
        enabled: harvestOk('water'),
        detail: harvestDetail(
          'water',
          `+${this.getWaterYield().toFixed(2)} water — craft a well for a larger draw`,
        ),
      },
      {
        id: 'hunt',
        title: 'Hunt / snares',
        enabled: harvestOk('hunt'),
        detail: harvestDetail(
          'hunt',
          `+${this.getHuntYield().toFixed(2)} raw meat — better with axe in bag or equipped`,
        ),
      },
      {
        id: 'berries',
        title: 'Gather berries',
        enabled: harvestOk('berries'),
        detail: harvestDetail('berries', `+${this.getBerriesYield().toFixed(2)} berries`),
      },
    ];

    const groups: GatherActionGroup[] = [
      { title: 'Minerals', actions: minerals },
      { title: 'Wood', actions: woodPlant },
      { title: 'Food', actions: food },
    ];

    if ((s.inventory.garden_plot ?? 0) >= 1) {
      groups.push({
        title: 'Garden',
        actions: [
          {
            id: 'tend_garden',
            title: 'Tend garden plot',
            enabled: harvestOk('tend_garden'),
            detail: harvestDetail(
              'tend_garden',
              '+berries, +herb, +water — uses your crafted garden plot',
            ),
          },
        ],
      });
    }

    if (s.unlockedCardIds.includes(MAGIC_ENTRY_CARD_ID)) {
      groups.push({
        title: 'Magic',
        actions: [
          {
            id: 'ley_residue',
            title: 'Channel residue',
            enabled: true,
            detail: `+${(0.028 * MANUAL_GATHER_YIELD_MULT).toFixed(3)} magic dust`,
          },
        ],
      });
    }

    return groups;
  }

  /**
   * Snapshot of the in-flight gather, or `null` when idle. UI uses this to disable gather
   * buttons across every tab (not just the one the click happened on) and to show progress.
   */
  getActiveGather(): { actionId: string; progress01: number } | null {
    const g = this.activeGather;
    if (!g) return null;
    const elapsed = Date.now() - g.startedAtMs;
    const progress01 = Math.max(0, Math.min(1, g.durationMs > 0 ? elapsed / g.durationMs : 1));
    return { actionId: g.actionId, progress01 };
  }

  /**
   * Begin a manual gather. Caller (UI) is responsible for kicking the dock animation
   * (`scenePreview.playGatherAction(...)`) **after** this returns true. Returns false if
   * another gather is already in flight or the action does not produce loot.
   *
   * `durationMs === 0` grants immediately (instant gather actions); otherwise the gather is
   * tracked in `activeGather` and `tick()` plays SFX at `sfxDelayMs` and grants loot at
   * `durationMs`. Survives tab switches because the lifecycle no longer lives inside the
   * gather-page click handler's `setTimeout` closure.
   */
  startGather(
    actionId: string,
    harvestSlot: number,
    durationMs: number,
    sfxDelayMs: number,
  ): boolean {
    if (this.activeGather) return false;
    if (durationMs <= 0) {
      return this.performGather(actionId, { harvestSlot });
    }
    this.activeGather = {
      actionId,
      harvestSlot,
      startedAtMs: Date.now(),
      durationMs,
      sfxDelayMs: Math.max(0, sfxDelayMs),
      sfxFired: false,
    };
    this.emit();
    return true;
  }

  /** Drop any in-flight gather (e.g. on reset / death wipe). */
  clearActiveGather(): void {
    if (!this.activeGather) return;
    this.activeGather = null;
    this.emit();
  }

  /** Called from `tick()` to advance the in-flight gather (SFX timing + loot grant). */
  private advanceActiveGather(): void {
    const g = this.activeGather;
    if (!g) return;
    const now = Date.now();
    const elapsed = now - g.startedAtMs;
    if (!g.sfxFired && elapsed >= g.sfxDelayMs) {
      g.sfxFired = true;
      playWorldSoundForGather(g.actionId);
    }
    if (elapsed >= g.durationMs) {
      const { actionId, harvestSlot } = g;
      this.activeGather = null;
      /* `skipSfx: true` because we already fired SFX at `sfxDelayMs` (matching the original
       * "play when avatar reaches the work phase" timing — not at clip end). performGather
       * already calls `emit()` internally, so we don't need to. */
      this.performGather(actionId, { skipSfx: true, harvestSlot });
    }
  }

  performGather(actionId: string, opts?: { skipSfx?: boolean; harvestSlot?: number }): boolean {
    const s = this.state;
    const coopSync = s.gameMode === 'coop' && s.onlineSession != null;
    const coopAdds: Record<string, number> = {};
    let coopCurrencyDelta = 0;
    const yMul = this.getHarvestYieldMultiplierForAction(actionId);
    const add = (resource: string, amount: number) => {
      const scaled = amount * yMul;
      s.inventory[resource] = (s.inventory[resource] ?? 0) + scaled;
      const cur = Math.max(0, Math.floor(scaled * 0.06));
      s.currency += cur;
      if (coopSync) {
        coopAdds[resource] = (coopAdds[resource] ?? 0) + scaled;
        coopCurrencyDelta += cur;
      }
    };
    const addBundle = (b: Record<string, number>) => {
      for (const [k, v] of Object.entries(b)) add(k, v);
    };

    switch (actionId) {
      case 'wood': {
        add('wood', this.getWoodYield());
        this.applyWoodWear(0.32);
        break;
      }
      case 'stone': {
        add('stone', this.getStoneYield());
        this.applyPickWear(0.34);
        break;
      }
      case 'fiber': {
        add('fiber', this.getFiberYield());
        break;
      }
      case 'berries': {
        add('berries', this.getBerriesYield());
        break;
      }
      case 'water': {
        add('water', this.getWaterYield());
        break;
      }
      case 'hunt': {
        add('raw_meat', this.getHuntYield());
        this.applyHuntWear(0.14);
        break;
      }
      case 'tend_garden': {
        if ((s.inventory.garden_plot ?? 0) < 1) return false;
        const g = MANUAL_GATHER_YIELD_MULT;
        addBundle({ berries: 0.52 * g, herb: 0.26 * g, water: 0.06 * g });
        break;
      }
      case 'mine_coal': {
        if (!this.effectivePickId()) return false;
        const bCoal = 0.26 * MANUAL_GATHER_YIELD_MULT;
        add('coal', bCoal * this.pickTierMult());
        this.applyPickWear(0.44);
        break;
      }
      case 'mine_iron_ore': {
        if (!this.effectivePickId()) return false;
        const bFe = 0.22 * MANUAL_GATHER_YIELD_MULT;
        add('iron_ore', bFe * this.pickTierMult());
        this.applyPickWear(0.4);
        break;
      }
      case 'mine_copper_ore': {
        if (!s.unlockedCardIds.includes('c_card_alloy_crucible')) return false;
        const pCu = this.effectivePickId();
        const bCu = 0.2 * MANUAL_GATHER_YIELD_MULT;
        add('copper_ore', pCu ? bCu * this.pickTierMult() : bCu * ORE_BARE_HANDS_MULT);
        if (pCu) this.applyPickWear(0.38);
        break;
      }
      case 'mine_tin_ore': {
        if (!s.unlockedCardIds.includes('c_card_alloy_crucible')) return false;
        const pSn = this.effectivePickId();
        const bSn = 0.19 * MANUAL_GATHER_YIELD_MULT;
        add('tin_ore', pSn ? bSn * this.pickTierMult() : bSn * ORE_BARE_HANDS_MULT);
        if (pSn) this.applyPickWear(0.38);
        break;
      }
      case 'mine_zinc_ore': {
        if (!s.unlockedCardIds.includes('c_card_alloy_crucible')) return false;
        const pZn = this.effectivePickId();
        const bZn = 0.18 * MANUAL_GATHER_YIELD_MULT;
        add('zinc_ore', pZn ? bZn * this.pickTierMult() : bZn * ORE_BARE_HANDS_MULT);
        if (pZn) this.applyPickWear(0.38);
        break;
      }
      case 'mine_silver_ore': {
        if (!s.unlockedCardIds.includes('c_card_precious_arc')) return false;
        const pAg = this.effectivePickId();
        const bAg = 0.15 * MANUAL_GATHER_YIELD_MULT;
        add('silver_ore', pAg ? bAg * this.pickTierMult() : bAg * ORE_BARE_HANDS_MULT);
        if (pAg) this.applyPickWear(0.42);
        break;
      }
      case 'mine_gold_ore': {
        if (!s.unlockedCardIds.includes('c_card_precious_arc')) return false;
        const pAu = this.effectivePickId();
        const bAu = 0.12 * MANUAL_GATHER_YIELD_MULT;
        add('gold_ore', pAu ? bAu * this.pickTierMult() : bAu * ORE_BARE_HANDS_MULT);
        if (pAu) this.applyPickWear(0.42);
        break;
      }
      case 'mine_platinum_ore': {
        if (!s.unlockedCardIds.includes('c_card_precious_arc')) return false;
        const pPt = this.effectivePickId();
        const bPt = 0.09 * MANUAL_GATHER_YIELD_MULT;
        add('platinum_ore', pPt ? bPt * this.pickTierMult() : bPt * ORE_BARE_HANDS_MULT);
        if (pPt) this.applyPickWear(0.45);
        break;
      }
      case 'ley_residue': {
        if (!s.unlockedCardIds.includes(MAGIC_ENTRY_CARD_ID)) return false;
        add('magic_dust', 0.028 * MANUAL_GATHER_YIELD_MULT);
        break;
      }
      default:
        return false;
    }
    this.applyHarvestDepletion(actionId, opts?.harvestSlot);
    if (!opts?.skipSfx) playWorldSoundForGather(actionId);
    if (coopSync && (Object.keys(coopAdds).length > 0 || coopCurrencyDelta !== 0)) {
      getRoomHub().coopOp({ add: coopAdds, currencyDelta: coopCurrencyDelta });
    }
    this.emit();
    return true;
  }

  private getWoodYield(): number {
    const base = 0.52;
    const w = this.state.equipment.weapon;
    const mult = w ? (AXE_WOOD_MULT[w] ?? 0.92) : 0.68;
    return base * mult * MANUAL_GATHER_YIELD_MULT;
  }

  private getStoneYield(): number {
    const base = 0.46;
    const p = this.effectivePickId();
    if (!p) return base * 0.55 * MANUAL_GATHER_YIELD_MULT;
    return base * (PICK_STONE_YIELD_MULT[p] ?? 1.98) * MANUAL_GATHER_YIELD_MULT;
  }

  private getFiberYield(): number {
    let m = 0.46;
    const w = this.state.equipment.weapon;
    if (isAxeWeaponId(w)) m *= 1.18;
    return m * MANUAL_GATHER_YIELD_MULT;
  }

  private getBerriesYield(): number {
    let m = 0.74;
    const w = this.state.equipment.weapon;
    if (isAxeWeaponId(w)) m *= 1.22;
    return m * MANUAL_GATHER_YIELD_MULT;
  }

  private getWaterYield(): number {
    let m = 0.39;
    if ((this.state.inventory.well ?? 0) >= 1) m *= 1.42;
    const w = this.state.equipment.weapon;
    if (isAxeWeaponId(w)) m *= 1.12;
    return m * MANUAL_GATHER_YIELD_MULT;
  }

  private getHuntYield(): number {
    let m = 0.31;
    const s = this.state;
    const hasAxe = AXE_TIER_ORDER.some((id) => (s.inventory[id] ?? 0) >= 1);
    if (hasAxe) m *= 1.62;
    const w = s.equipment.weapon;
    if (isAxeWeaponId(w)) m *= 1.12;
    return m * MANUAL_GATHER_YIELD_MULT;
  }

  /**
   * Which pick applies to mining actions: equipped pick if valid, else best pick in bag.
   */
  private effectivePickId(): string | null {
    const s = this.state;
    const ep = s.equipment.pick;
    if (ep && (s.inventory[ep] ?? 0) >= 1 && PICK_TIER_ORDER.includes(ep)) return ep;
    for (const id of PICK_TIER_ORDER) {
      if ((s.inventory[id] ?? 0) >= 1) return id;
    }
    return null;
  }

  /** Extra yield mult for pick-dependent gathers (coal / ore). */
  private pickTierMult(): number {
    const p = this.effectivePickId();
    if (!p) return 0.6;
    return PICK_ORE_YIELD_MULT[p] ?? 0.6;
  }

  private applyWoodWear(base: number): void {
    const w = this.state.equipment.weapon;
    if (isAxeWeaponId(w) && w) this.applyToolWear(w, base);
  }

  private applyPickWear(base: number): void {
    const t = this.effectivePickId();
    if (!t) return;
    const f = PICK_WEAR_FACTOR[t] ?? 1;
    this.applyToolWear(t, base * f);
  }

  private applyHuntWear(base: number): void {
    const s = this.state;
    let use: string | null = null;
    for (const id of AXE_TIER_ORDER) {
      if ((s.inventory[id] ?? 0) >= 1) {
        use = id;
        break;
      }
    }
    if (!use) return;
    if (s.equipment.weapon === use) this.applyToolWear(use, base);
    else this.applyToolWear(use, base * 0.45);
  }

  applyToolWear(itemId: string, amount: number): void {
    if (!isDurabilityItem(itemId)) return;
    const s = this.state;
    if ((s.inventory[itemId] ?? 0) < 1) return;
    ensureDurability(s, itemId);
    s.toolDurability[itemId] = Math.max(0, (s.toolDurability[itemId] ?? 100) - amount);
    if (s.toolDurability[itemId] <= 0) {
      s.inventory[itemId] = Math.max(0, (s.inventory[itemId] ?? 0) - 1);
      delete s.toolDurability[itemId];
      if (s.equipment.weapon === itemId) s.equipment.weapon = null;
      if (s.equipment.shield === itemId) s.equipment.shield = null;
      if (s.equipment.pick === itemId) s.equipment.pick = null;
    }
  }

  repairItem(itemId: string): boolean {
    if (!isDurabilityItem(itemId)) return false;
    if ((this.state.inventory.repair_bench ?? 0) < 1) return false;
    if ((this.state.inventory[itemId] ?? 0) < 1) return false;
    if (!spendInv(this.state.inventory, { wood: 2, fiber: 1 })) return false;
    ensureDurability(this.state, itemId);
    this.state.toolDurability[itemId] = Math.min(100, (this.state.toolDurability[itemId] ?? 0) + 35);
    this.emit();
    return true;
  }

  equip(slot: EquipSlot, itemId: string | null): boolean {
    const s = this.state;
    if (itemId === null) {
      s.equipment[slot] = null;
      this.emit();
      return true;
    }
    if ((s.inventory[itemId] ?? 0) < 1) return false;
    if (slot === 'weapon' && !(EQUIPPABLE_WEAPON_IDS as readonly string[]).includes(itemId)) return false;
    if (slot === 'shield' && !(EQUIPPABLE_SHIELD_IDS as readonly string[]).includes(itemId)) return false;
    if (slot === 'pick' && !(EQUIPPABLE_PICK_IDS as readonly string[]).includes(itemId)) return false;
    if (slot === 'armor') return false;
    s.equipment[slot] = itemId;
    this.emit();
    return true;
  }

  consumeFood(itemId: 'cooked_meat' | 'berries', amount = 1): boolean {
    const s = this.state;
    if ((s.inventory[itemId] ?? 0) < amount) return false;
    s.inventory[itemId] -= amount;
    if (itemId === 'cooked_meat') {
      s.hunger = Math.min(100, s.hunger + 22);
      s.playerHp = Math.min(s.playerMaxHp, s.playerHp + 2);
    } else {
      s.hunger = Math.min(100, s.hunger + 8);
    }
    playConsumeSound(itemId === 'cooked_meat' ? 'meat' : 'berries');
    this.emit();
    return true;
  }

  drinkWater(amount = 1): boolean {
    const s = this.state;
    if ((s.inventory.water ?? 0) < amount) return false;
    s.inventory.water -= amount;
    s.thirst = Math.min(100, s.thirst + 18);
    playConsumeSound('water');
    this.emit();
    return true;
  }

  clearDeathMessage(): void {
    this.state.lastDeathHeadline = null;
    this.state.lastDeathBody = null;
    saveState(this.state);
    this.emit();
  }

  /* --------- Awakening / realm-mode (Act 2 → Act 3 in `LORE.md` + `docs/AWAKENING_AND_FREE_ROAM_PLAN.md`) --------- */

  getRealmMode(): RealmMode {
    return this.state.realmMode;
  }

  getShards(): ShardState {
    return this.state.shards;
  }

  /** Number of shards recovered (0-3). UI summary helper. */
  getShardCount(): number {
    const s = this.state.shards;
    return (s.cori ? 1 : 0) + (s.jenny ? 1 : 0) + (s.kristin ? 1 : 0);
  }

  /** True when the awakening tab should be visible — any shard recovered OR dev flag on. */
  getAwakeningVisible(): boolean {
    return this.getShardCount() > 0 || isDevAwakeningUnlocked();
  }

  /** True when the "Break the spell" button should activate — all 3 shards OR dev flag. */
  getCanBreakFree(): boolean {
    return this.getShardCount() >= 3 || isDevAwakeningUnlocked();
  }

  /**
   * Next witch enemy id to spawn, or `null` when all three are defeated. Drives both the
   * battle-scheduling rule in `startPveBattle` (Phase B) and the awakening UI's
   * "next: Witch of the Eastern Coven" label.
   */
  getNextWitchId(): WitchShardId | null {
    return this.state.witchOrder[0] ?? null;
  }

  /**
   * Called by the battle victory path (Phase B) when the defeated enemy was a witch.
   * Marks the shard recovered, drops it into inventory as a tangible item, and resets
   * the witch counter so the next ~15 fights are regular PvE again.
   */
  recordShardDrop(witchId: WitchShardId): void {
    const s = this.state;
    if (s.shards[witchId]) return; /* idempotent — already recorded */
    s.shards[witchId] = true;
    s.witchOrder = s.witchOrder.filter((id) => id !== witchId);
    s.witchBattlesUntilNext = WITCH_BATTLE_INTERVAL;
    const itemId = `talisman_shard_${witchId}`;
    s.inventory[itemId] = (s.inventory[itemId] ?? 0) + 1;
    saveState(s);
    this.emit();
  }

  /**
   * Decrement the witch countdown after a regular PvE win (not a witch fight). Wires from
   * `startPveBattle`'s post-victory path (Phase B). No-op when no witches are pending.
   */
  decrementWitchCounter(): void {
    if (this.state.witchOrder.length === 0) return;
    if (this.state.witchBattlesUntilNext > 0) {
      this.state.witchBattlesUntilNext -= 1;
      saveState(this.state);
      this.emit();
    }
  }

  /**
   * The big lever — flip realm to `'awakened'` (the Vanguard wakes from the dream-prison).
   * Called from the awakening page's Break button after gating on `getCanBreakFree()`.
   * Returns false if the gate fails. Cutscene `awakening_break_the_spell` is stubbed; the
   * UI plays a fade-to-white during the flip (real cutscene production deferred — see
   * `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §13). Two-way: see {@link setRealmMode}.
   */
  breakTheSpell(): boolean {
    if (!this.getCanBreakFree()) return false;
    this.setRealmMode('awakened');
    return true;
  }

  /**
   * Direct realm-mode setter for the round-trip toggle (system-menu / debug). The UI is
   * responsible for any visual transition; this just flips the state, persists, and emits.
   * Refuses to flip mid-battle so we don't orphan a `BattleState` (see plan §12 risks).
   */
  setRealmMode(mode: RealmMode): boolean {
    if (this.state.realmMode === mode) return true;
    if (this.state.battle) return false; /* finish your fight first */
    this.state.realmMode = mode;
    saveState(this.state);
    this.emit();
    return true;
  }

  /**
   * Phase D — free-roam harvest of a world node. Routes most kinds to existing
   * `performGather` core so yield + inventory + currency math stays consistent with deck
   * mode. Magic crystals get a dedicated path because they ALSO bump
   * `magicCrystalsHarvested` (drives `getEffectiveMaxMana()` growth).
   *
   * Multi-hit awakened harvest (`docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §8 supersession):
   * `freeRoamHarvest()` is now ONLY called on the FINAL hit of a node (when the tree
   * falls / boulder crumbles / ore shatters). Per-hit chip yield goes through
   * `freeRoamHarvestChip()` instead. We pass `skipSfx: true` so the harvest module's
   * dedicated `playHarvestBreakSound()` fires unopposed (the legacy single-shot
   * `playWorldSoundForGather` would step on the climactic crash).
   */
  freeRoamHarvest(kind: string): boolean {
    if (kind === 'magic_crystal') {
      const yieldQty = 1 + Math.floor(Math.random() * 2); /* 1-2 crystals per node */
      this.state.inventory.magic_crystal = (this.state.inventory.magic_crystal ?? 0) + yieldQty;
      this.state.magicCrystalsHarvested += yieldQty;
      saveState(this.state);
      this.emit();
      return true;
    }
    /* All other kinds map directly to existing gather actions (wood / fiber / stone /
     * mine_*). Pass through the regular performGather pipeline so yield math + currency
     * drop + pick wear stay consistent with deck-mode gather. SFX is skipped — the
     * awakened harvest caller owns the climactic break SFX (`playHarvestBreakSound`)
     * which is acoustically richer than the legacy single-shot. */
    return this.performGather(kind, { skipSfx: true });
  }

  /**
   * Per-hit "chip" yield during the awakened-mode multi-hit harvest loop. Drops a small
   * raw-resource amount into inventory with NO mastery scaling, NO currency drop, NO
   * tool wear, and NO SFX (the harvest module fires its own `playHarvestProgressSound`).
   *
   * The big bookkeeping (mastery, currency, tool wear, depletion) all happens on the
   * final hit via `freeRoamHarvest()`. This split keeps the "feel" satisfying — every
   * swing produces something visible in the bag — without inflating the per-hit
   * accounting cost or letting players farm chips faster than the design intends.
   *
   * `qty` is in raw inventory units (e.g. `0.5` wood, `0.3` iron_ore). Caller decides
   * the per-hit amount based on `maxHp`; total chip + final-break yield is balanced to
   * roughly match the legacy single-press freeRoamHarvest output.
   */
  freeRoamHarvestChip(kind: string, qty: number): void {
    if (qty <= 0) return;
    const resource = this.harvestKindToInventoryKey(kind);
    if (!resource) return;
    const s = this.state;
    s.inventory[resource] = (s.inventory[resource] ?? 0) + qty;
    if (kind === 'magic_crystal') {
      /* Crystal chips also feed the mana pool; magnitude scales with the chip qty so
       * this stays consistent with `freeRoamHarvest` for the final-break path. */
      s.magicCrystalsHarvested += qty;
    }
    saveState(s);
    this.emit();
  }

  /** Map a free-roam harvest kind to its inventory resource id. */
  private harvestKindToInventoryKey(kind: string): string | null {
    switch (kind) {
      case 'wood': return 'wood';
      case 'stone': return 'stone';
      case 'fiber': return 'fiber';
      case 'berries': return 'berries';
      case 'mine_iron_ore': return 'iron_ore';
      case 'mine_coal': return 'coal';
      case 'mine_copper_ore': return 'copper_ore';
      case 'mine_tin_ore': return 'tin_ore';
      case 'mine_zinc_ore': return 'zinc_ore';
      case 'mine_silver_ore': return 'silver_ore';
      case 'mine_gold_ore': return 'gold_ore';
      case 'mine_platinum_ore': return 'platinum_ore';
      case 'magic_crystal': return 'magic_crystal';
      default: return null;
    }
  }

  /**
   * Awakened-mode multi-hit harvest: equipped-tool damage multiplier. Returns the
   * fraction of the node's HP each E-press removes. Higher tier → larger multiplier →
   * fewer hits to break.
   *
   * Tier table (matches `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §4):
   *   bare hand                        = 1.0   (e.g. 8 hits on a tree)
   *   basic axe / pickaxe              = 1.66  (≈5 hits)
   *   iron axe / iron pickaxe          = 2.22  (≈4 hits)
   *   copper / bronze / brass tools    = 2.85  (≈3 hits)
   *   steel tools                      = 4.0   (≈2 hits)
   *   silver / gold / platinum picks   = 5.0   (≈2 hits, precious metal tier)
   *
   * Wrong tool family (axe on stone, pick on tree) = 1.0 bare-hand baseline. Fiber,
   * berries, and crystal kinds always bare-hand (no tool family applies).
   */
  getHarvestHitsMultiplier(kind: string): number {
    const w = this.state.equipment.weapon;
    if (!w) return 1.0;
    /* Determine which tool family this kind needs. */
    const isWood = kind === 'wood';
    const isStoneOrOre = kind === 'stone' || kind.startsWith('mine_');
    if (!isWood && !isStoneOrOre) return 1.0; /* fiber, berries, crystal — no tool helps */
    const tier = (() => {
      if (isWood) {
        switch (w) {
          case 'steel_axe': return 4.0;
          case 'brass_axe': return 2.85;
          case 'bronze_axe': return 2.85;
          case 'copper_axe': return 2.85;
          case 'iron_axe': return 2.22;
          case 'axe': return 1.66;
          default: return 1.0; /* equipped a sword / pickaxe / etc. */
        }
      }
      switch (w) {
        case 'platinum_pickaxe': return 5.0;
        case 'gold_pickaxe': return 5.0;
        case 'silver_pickaxe': return 5.0;
        case 'steel_pickaxe': return 4.0;
        case 'brass_pickaxe': return 2.85;
        case 'bronze_pickaxe': return 2.85;
        case 'copper_pickaxe': return 2.85;
        case 'iron_pickaxe': return 2.22;
        case 'pickaxe': return 1.66;
        default: return 1.0;
      }
    })();
    return tier;
  }

  /* ============================================================================
   * Awakened-mode base building (Phase 1 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md)
   * ============================================================================ */

  /**
   * Place a log-cabin piece at world (x, y, z) with rotation `rotY`. Validates the
   * player has the materials in inventory; on success, decrements the materials,
   * pushes a fresh `PlacedCabinPiece` with rolled-from-tier max HP, increments the
   * counter, saves, and emits.
   *
   * Caller is responsible for the geometric validation (terrain slope, prerequisite
   * pieces, snap collision) — that lives in `buildModeController`. This method is the
   * authoritative state mutation only; it does NOT enforce build-mode rules so the
   * future placement-from-load and multiplayer-replay paths can re-use it directly.
   *
   * Returns the placed piece on success or `null` if materials are missing.
   */
  placeCabinPiece(
    kind: CabinPieceKind,
    tier: CabinMaterialTier,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ): PlacedCabinPiece | null {
    const cost = cabinPieceCost(kind, tier);
    if (!hasItems(this.state.inventory, cost)) return null;
    /* Decrement each material atomically — the hasItems gate above guarantees no
     * partial-spend can happen since we already proved every key is sufficient. */
    for (const [k, q] of Object.entries(cost)) {
      this.state.inventory[k] = (this.state.inventory[k] ?? 0) - q;
    }
    const id = ++this.state.placedCabinPieceCounter;
    const maxHp = cabinPieceMaxHp(kind, tier);
    const piece: PlacedCabinPiece = {
      id,
      kind,
      tier,
      x, y, z,
      rotY,
      hp: maxHp,
      maxHp,
      crystalWrap: null,
    };
    this.state.placedCabinPieces.push(piece);
    saveState(this.state);
    this.emit();
    return piece;
  }

  /**
   * Remove a placed cabin piece and refund 50% of its base material cost (anti-grief —
   * encourages thoughtful placement without making mis-placements catastrophic). Returns
   * true if the piece existed and was removed.
   *
   * Note: refund uses `cabinPieceCost(kind, tier)` × 0.5 floored — so a piece costing
   * 4 logs refunds 2; a piece costing 1 log refunds 0 (sentinel against infinite-build
   * exploits). Repair cost in Phase 4 will use a different formula.
   */
  removeCabinPiece(id: number): boolean {
    const idx = this.state.placedCabinPieces.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const piece = this.state.placedCabinPieces[idx]!;
    const cost = cabinPieceCost(piece.kind, piece.tier);
    for (const [k, q] of Object.entries(cost)) {
      const refund = Math.floor(q * 0.5);
      if (refund > 0) {
        this.state.inventory[k] = (this.state.inventory[k] ?? 0) + refund;
      }
    }
    this.state.placedCabinPieces.splice(idx, 1);
    saveState(this.state);
    this.emit();
    return true;
  }

  /**
   * Apply damage to a placed cabin piece (Phase 8h pending — magic-as-universal-
   * damage). Decrements HP; when HP <= 0, removes the piece via `removeCabinPiece`
   * (which keeps the standard 50% refund — magic destruction is destructive
   * intent on the player's part, but not punitive).
   *
   * Returns `{ destroyed, hpRemaining }` so callers can route VFX (chip dust on
   * non-lethal hit, full collapse on destroy). Returns `null` when the id
   * doesn't exist or the piece is already at 0 HP. Caller should clamp the
   * incoming damage value sensibly — magic chips at low values (1-3) so a
   * single accidental shot doesn't wipe a foundation.
   */
  damageCabinPiece(id: number, amount: number): { destroyed: boolean; hpRemaining: number } | null {
    if (amount <= 0) return null;
    const piece = this.state.placedCabinPieces.find((p) => p.id === id);
    if (!piece || piece.hp <= 0) return null;
    piece.hp = Math.max(0, piece.hp - amount);
    if (piece.hp <= 0) {
      this.removeCabinPiece(id);
      return { destroyed: true, hpRemaining: 0 };
    }
    saveState(this.state);
    this.emit();
    return { destroyed: false, hpRemaining: piece.hp };
  }

  /** Snapshot accessor for renderers + UI; the array is the live store reference, do not mutate. */
  getPlacedCabinPieces(): ReadonlyArray<PlacedCabinPiece> {
    return this.state.placedCabinPieces;
  }

  /* ----------------------------------------------------------------------------
   * Awakened-mode multi-instance craft-station placement
   * (Phase 2 of base-building — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §9).
   *
   * Players open Build mode in awakened realm, pick a station kind from the
   * Stations sub-section, and place a fresh `PlacedCraftStation` at the ghost
   * preview's XZ. Materials are decremented directly (no inventory token round-
   * trip — mirrors the cabin-piece pattern). Many stations of one kind may
   * coexist; the renderer (`craftStationBuilder.ts`) builds one LPCA Group per
   * placed entry.
   *
   * Dream-mode dock-yard slots are SEPARATE — those render from `state.stations`
   * + `inventory[campfire/workbench/...]` exactly as before. Players in deck
   * mode never see `placedCraftStations` populated.
   * ---------------------------------------------------------------------------- */

  /**
   * Material cost to place one station of `kind`. Same numbers as the dream-mode
   * recipes in `content.ts` (`r_campfire` / `r_workbench` / `r_forge` /
   * `r_kitchen`) so a player who's used to dream-mode crafting recognizes the
   * cost. Returns a fresh `Record<string, number>` ready to feed `hasItems` /
   * inventory decrement.
   */
  craftStationCost(kind: PlacedCraftStationKind): Record<string, number> {
    return craftStationCost(kind);
  }

  /**
   * Max HP for a station of `kind`. Frozen into the placed station at place-time
   * so a future balance retune doesn't break existing saves. Provisional values;
   * Phase 4 damage system will tune.
   */
  craftStationMaxHp(kind: PlacedCraftStationKind): number {
    return craftStationMaxHp(kind);
  }

  /**
   * Place a craft station at world (x, y, z) with rotation `rotY`. Validates the
   * player has the materials in inventory; on success, decrements the materials,
   * pushes a fresh `PlacedCraftStation` with rolled-from-kind max HP, increments
   * the counter, saves, and emits.
   *
   * Caller is responsible for the geometric validation (terrain slope, snap
   * collision, awakened-mode gate) — that lives in `buildModeController`. This
   * method is the authoritative state mutation only.
   *
   * Returns the placed station on success or `null` if materials are missing.
   */
  placeCraftStation(
    kind: PlacedCraftStationKind,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ): PlacedCraftStation | null {
    const cost = craftStationCost(kind);
    if (!hasItems(this.state.inventory, cost)) return null;
    for (const [k, q] of Object.entries(cost)) {
      this.state.inventory[k] = (this.state.inventory[k] ?? 0) - q;
    }
    const id = ++this.state.placedCraftStationCounter;
    const maxHp = craftStationMaxHp(kind);
    const station: PlacedCraftStation = {
      id,
      kind,
      x, y, z,
      rotY,
      hp: maxHp,
      maxHp,
    };
    this.state.placedCraftStations.push(station);
    saveState(this.state);
    this.emit();
    return station;
  }

  /**
   * Remove a placed craft station and refund 50% of its base material cost
   * (anti-grief — matches the cabin-piece refund pattern). Returns true if the
   * station existed and was removed.
   */
  removeCraftStation(id: number): boolean {
    const idx = this.state.placedCraftStations.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    const station = this.state.placedCraftStations[idx]!;
    const cost = craftStationCost(station.kind);
    for (const [k, q] of Object.entries(cost)) {
      const refund = Math.floor(q * 0.5);
      if (refund > 0) {
        this.state.inventory[k] = (this.state.inventory[k] ?? 0) + refund;
      }
    }
    this.state.placedCraftStations.splice(idx, 1);
    saveState(this.state);
    this.emit();
    return true;
  }

  /**
   * Apply damage to a placed craft station (Phase 8h pending — magic-as-
   * universal-damage). Same pattern as `damageCabinPiece`: decrement HP,
   * remove + 50% refund on destroy. Returns `null` when the id is unknown
   * or the station is already destroyed. */
  damageCraftStation(id: number, amount: number): { destroyed: boolean; hpRemaining: number } | null {
    if (amount <= 0) return null;
    const station = this.state.placedCraftStations.find((s) => s.id === id);
    if (!station || station.hp <= 0) return null;
    station.hp = Math.max(0, station.hp - amount);
    if (station.hp <= 0) {
      this.removeCraftStation(id);
      return { destroyed: true, hpRemaining: 0 };
    }
    saveState(this.state);
    this.emit();
    return { destroyed: false, hpRemaining: station.hp };
  }

  /** Snapshot accessor for renderers + UI; the array is the live store reference, do not mutate. */
  getPlacedCraftStations(): ReadonlyArray<PlacedCraftStation> {
    return this.state.placedCraftStations;
  }

  /* ============================================================================
   * Awakened-mode combat runtime (Phase 1.5 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §13)
   *
   * Mobs, magic projectiles, and combat damage are runtime-only — NOT persisted to
   * `GameState` (matches the existing `activeGather` runtime pattern). Wave system
   * resets on reload, by design — no half-completed combat survives a refresh.
   * ============================================================================ */

  /** Live mob roster — runtime-only, NOT persisted. Spawned by `awakenedMobs.ts` AI. */
  private activeAwakenedMobs: AwakenedMobInstance[] = [];
  /** Monotonic counter for assigning fresh `AwakenedMobInstance.id`s within a session. */
  private awakenedMobCounter = 0;

  /**
   * Spawn a new mob at world (x, z). Y resolved by caller (terrain sampler). Pushed to
   * the runtime list and returned. AI tick in `awakenedMobs.ts` then drives state.
   */
  spawnAwakenedMob(kind: AwakenedMobKind, x: number, y: number, z: number): AwakenedMobInstance {
    const stats = AWAKENED_MOB_STATS[kind];
    const id = ++this.awakenedMobCounter;
    const mob: AwakenedMobInstance = {
      id,
      kind,
      x, y, z,
      rotY: 0,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      state: 'idle',
      attackReadyMs: 0,
      diesAtMs: 0,
      corpseExpiresAtMs: 0,
    };
    this.activeAwakenedMobs.push(mob);
    return mob;
  }

  /**
   * Apply damage to a mob. Returns true if this hit took it to 0 HP (caller can fire
   * the death animation + drop loot). Mob stays in the list with `state: 'dying'`
   * until its `diesAtMs` elapses, then `removeAwakenedMob` is called by the AI tick.
   */
  damageAwakenedMob(id: number, amount: number): boolean {
    const mob = this.activeAwakenedMobs.find((m) => m.id === id);
    if (!mob || mob.state === 'dying') return false;
    mob.hp = Math.max(0, mob.hp - amount);
    if (mob.hp <= 0) {
      mob.state = 'dying';
      mob.diesAtMs = Date.now() + 1500; /* death anim window */
      return true;
    }
    return false;
  }

  /** Remove a mob from the runtime list (called by AI tick after death anim completes). */
  removeAwakenedMob(id: number): void {
    const i = this.activeAwakenedMobs.findIndex((m) => m.id === id);
    if (i >= 0) this.activeAwakenedMobs.splice(i, 1);
  }

  /** Live snapshot of all mobs (for AI tick + lock-on cone scan). Don't mutate. */
  getActiveAwakenedMobs(): ReadonlyArray<AwakenedMobInstance> {
    return this.activeAwakenedMobs;
  }

  /** Clear all mobs — used by realm-flip-to-deck and permadeath. */
  clearAwakenedMobs(): void {
    this.activeAwakenedMobs = [];
  }

  /**
   * Replace runtime mob roster from the render worker's authority simulation
   * (Wave 1 migration). Shallow-copies each instance so worker-owned buffers
   * are not aliased on main.
   */
  applyAwakenedMobsAuthorityFromWorker(
    mobs: readonly AwakenedMobInstance[],
    mobCounter: number,
  ): void {
    this.activeAwakenedMobs = mobs.map((m) => ({ ...m }));
    this.awakenedMobCounter = mobCounter;
  }

  /**
   * Apply combat damage to the player in awakened mode. Routes through the existing
   * `playerHp` field (vitals shared between modes per `GAME_MASTER.md` §1). Block
   * reduction applied by caller — this method takes the FINAL damage value. Triggers
   * existing permadeath path at HP <= 0.
   */
  damagePlayerInAwakened(amount: number, sourceKind: string): void {
    if (amount <= 0) return;
    const next = Math.max(0, this.state.playerHp - amount);
    this.state.playerHp = next;
    if (next <= 0) {
      this.dieAndWipe(
        'Slain in the awakened world',
        `${sourceKind} struck you down before you could weave the next ward.`,
      );
      return;
    }
    saveState(this.state);
    this.emit();
  }

  /**
   * Spend mana for a magic action (LMB cast). Returns true if the spend succeeded;
   * false if insufficient mana (caller should skip the cast + play empty-cast SFX).
   * Uses base `state.mana` (not `getEffectiveMaxMana()` — that's the cap, not the
   * spend pool).
   */
  useMana(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.state.mana + 1e-9 < amount) return false;
    this.state.mana -= amount;
    saveState(this.state);
    this.emit();
    return true;
  }

  /**
   * Equip a spell into the awakened-mode offensive slot (drives `castMagic`'s damage +
   * mana cost). Pass `null` to clear the slot. Validates that the card is unlocked AND
   * is a damage-dealing spell — silently no-ops on invalid ids so a stale picker click
   * can't equip a non-spell. The companion `getOffensiveSpellCard()` returns the live
   * `CardDef` for combat to read.
   */
  equipOffensiveSpell(cardId: string | null): void {
    if (cardId == null) {
      this.state.equippedOffensiveSpellId = null;
    } else {
      if (!this.state.unlockedCardIds.includes(cardId)) return;
      const card = cardDefs.find((c) => c.id === cardId);
      if (!card || card.battle?.attackStyle !== 'spell') return;
      if (typeof card.battle.damage !== 'number' || card.battle.damage <= 0) return;
      this.state.equippedOffensiveSpellId = cardId;
    }
    saveState(this.state);
    this.emit();
  }

  /**
   * Equip a spell into the awakened-mode defensive slot. Validates that the card is
   * unlocked AND has a `wardFlat` (the dream-mode "absorbs N damage" mechanic — the
   * awakened ward bubble re-uses it as the per-second mana drain proxy). Pass null to
   * clear. Mend / heal spells aren't currently classed as defensive in awakened — they
   * stay deck-mode-only.
   */
  equipDefensiveSpell(cardId: string | null): void {
    if (cardId == null) {
      this.state.equippedDefensiveSpellId = null;
    } else {
      if (!this.state.unlockedCardIds.includes(cardId)) return;
      const card = cardDefs.find((c) => c.id === cardId);
      if (!card || card.battle?.attackStyle !== 'spell') return;
      if (typeof card.battle.wardFlat !== 'number' || card.battle.wardFlat <= 0) return;
      this.state.equippedDefensiveSpellId = cardId;
    }
    saveState(this.state);
    this.emit();
  }

  /** Live `CardDef` for the equipped offensive spell, or null when no slot is set. */
  getOffensiveSpellCard(): CardDef | null {
    const id = this.state.equippedOffensiveSpellId;
    if (!id) return null;
    return cardDefs.find((c) => c.id === id) ?? null;
  }
  /** Live `CardDef` for the equipped defensive spell, or null when no slot is set. */
  getDefensiveSpellCard(): CardDef | null {
    const id = this.state.equippedDefensiveSpellId;
    if (!id) return null;
    return cardDefs.find((c) => c.id === id) ?? null;
  }

  /**
   * Set the awakened-mode combat mode. `'hit'` = LMB melee only (no spell cast even
   * with one equipped); `'magic'` = LMB casts equipped offensive spell + swings
   * melee at close range simultaneously. Persisted across realm flips so the
   * player's preference survives a deck<->awakened toggle.
   */
  setCombatMode(mode: 'hit' | 'magic'): void {
    if (this.state.combatMode === mode) return;
    this.state.combatMode = mode;
    saveState(this.state);
    this.emit();
  }

  /** Convenience flip — used by the M hotkey + the shortcut bar's toggle button. */
  toggleCombatMode(): void {
    this.setCombatMode(this.state.combatMode === 'magic' ? 'hit' : 'magic');
  }

  /** L key in awakened — no-op without torch in inventory. */
  toggleTorchEquipped(): void {
    if ((this.state.inventory.torch ?? 0) <= 0) return;
    this.state.torchEquipped = !this.state.torchEquipped;
    saveState(this.state);
    this.emit();
  }

  /**
   * Add raw meat to inventory — used by the awakened-mode mob skin interaction
   * (rat / wolf corpses dropped by player kills). Routes to the same `raw_meat`
   * inventory key the existing dream-mode hunt clip deposits to, so the
   * campfire `r_cook_meat` recipe consumes it without any extra wiring.
   */
  grantRawMeat(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.state.inventory.raw_meat = (this.state.inventory.raw_meat ?? 0) + amount;
    saveState(this.state);
    this.emit();
  }

  /**
   * Add coin currency — used by awakened-mode mob kills (each rat/wolf/wanderer
   * drops a configured amount via `MOB_LOOT` in `awakenedMobs.ts`). Public
   * counterpart to the existing internal `+=` paths (battle-victory rewards,
   * merchant payouts) so the awakened-combat layer doesn't have to reach into
   * `state.currency` directly.
   */
  grantCurrency(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.state.currency += amount;
    saveState(this.state);
    this.emit();
  }

  /**
   * Assign an inventory item id (or null to clear) into a 0-indexed hotbar slot
   * (0..5 maps to keys 1..6). Validates the slot range; `itemId` is NOT validated
   * against current inventory (the player can pre-assign an item they're about
   * to acquire — `useHotbarSlot` checks the count at use time). Same item can
   * appear in multiple slots (intentional — a player might want two slots of
   * berries for fast double-tap snacking).
   */
  assignHotbarSlot(slotIdx: number, itemId: string | null): void {
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= 6) return;
    if (this.state.hotbarSlots[slotIdx] === itemId) return;
    this.state.hotbarSlots[slotIdx] = itemId;
    saveState(this.state);
    this.emit();
  }

  /** Live snapshot of the 6-slot hotbar. Don't mutate. */
  getHotbarSlots(): ReadonlyArray<string | null> {
    return this.state.hotbarSlots;
  }

  /**
   * Use the item in the given hotbar slot. Routes to the appropriate consume
   * method based on the assigned id. Returns true if the consume succeeded
   * (item found in inventory + applied effect), false on any of: invalid slot,
   * empty slot, unknown item id, or insufficient inventory.
   *
   * Adding a new consumable: extend the switch below + add the id to
   * `data/consumables.ts CONSUMABLE_ITEM_IDS`.
   */
  useHotbarSlot(slotIdx: number): boolean {
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= 6) return false;
    const itemId = this.state.hotbarSlots[slotIdx];
    if (!itemId) return false;
    switch (itemId) {
      case 'berries':
        return this.consumeFood('berries', 1);
      case 'cooked_meat':
        return this.consumeFood('cooked_meat', 1);
      case 'water':
        return this.drinkWater(1);
      default:
        /* Unknown id — slot was assigned to something we don't have a use-action
         * for. Could happen if a future build adds consumables and the player's
         * save references one we removed. Leave the slot assigned (player can
         * re-pick) but no-op the use. */
        return false;
    }
  }

  /** Permadeath: full reset. Wipes save file and starts a new run. */
  private dieAndWipe(headline: string, body: string): void {
    const prevTutorial = this.state.tutorial;
    setBattleMusicMode(false);
    this.activeGather = null;
    getRoomHub().leaveRoom();
    /* Clear awakened-mode runtime state — `activeAwakenedMobs` is a private store
     * field separate from `state`, so `createInitialState()` below WOULDN'T touch
     * it. Without this clear, mobs that were chasing the player at the moment of
     * death stayed alive after respawn — exactly what the player reported ("they
     * just sit around after they kill me"). The `awakenedMobs` render handle has
     * an orphan-cleanup guard in its `update()` that detects an empty store list
     * and despawns its visual / collision footprints to match. */
    this.clearAwakenedMobs();
    this.awakenedMobCounter = 0;
    this.state = createInitialState();
    this.state.tutorial = tutorialAfterPermadeathWipe(prevTutorial);
    this.state.lastDeathHeadline = headline;
    this.state.lastDeathBody = body;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* private mode */
    }
    saveState(this.state);
    this.emit();
  }

  /** Matches consumeFood: +22 per cooked meat, +8 per berries. */
  private tryFeedPlayerHunger(s: GameState, wantPoints: number): void {
    if (wantPoints <= 0) return;
    const cap = 100 - s.hunger;
    if (cap <= 0) return;
    let remaining = Math.min(wantPoints, cap);
    const meatPer = 22;
    const berryPer = 8;
    const meat = s.inventory.cooked_meat ?? 0;
    const meatUse = Math.min(meat, remaining / meatPer);
    if (meatUse > 0) {
      s.inventory.cooked_meat = meat - meatUse;
      const gain = meatUse * meatPer;
      s.hunger = Math.min(100, s.hunger + gain);
      remaining -= gain;
    }
    if (remaining < 0.25) return;
    const berries = s.inventory.berries ?? 0;
    const berryUse = Math.min(berries, remaining / berryPer);
    if (berryUse > 0) {
      s.inventory.berries = berries - berryUse;
      s.hunger = Math.min(100, s.hunger + berryUse * berryPer);
    }
  }

  /** Matches drinkWater: +18 per water unit. */
  private tryFeedPlayerThirst(s: GameState, wantPoints: number): void {
    if (wantPoints <= 0) return;
    const cap = 100 - s.thirst;
    if (cap <= 0) return;
    const remaining = Math.min(wantPoints, cap);
    const wPer = 18;
    const water = s.inventory.water ?? 0;
    const waterUse = Math.min(water, remaining / wPer);
    if (waterUse > 0) {
      s.inventory.water = water - waterUse;
      s.thirst = Math.min(100, s.thirst + waterUse * wPer);
    }
  }

  private applyHelperPlayerFeed(dt: number): void {
    const s = this.state;
    const minuteFrac = dt / 60;
    for (const hid of s.hiredHelperIds) {
      const h = helperById.get(hid);
      if (!h?.feedPlayer) continue;
      const hungerWant = (h.feedPlayer.hungerPerMinute ?? 0) * minuteFrac;
      const thirstWant = (h.feedPlayer.thirstPerMinute ?? 0) * minuteFrac;
      this.tryFeedPlayerHunger(s, hungerWant);
      this.tryFeedPlayerThirst(s, thirstWant);
    }
  }

  tick(realDtMs: number): void {
    const s = this.state;
    const dt = realDtMs / 1000;
    if (dt <= 0 || dt > 5) {
      s.lastRealMs = Date.now();
      return;
    }

    /* In-flight manual gather (started by `startGather`) — runs every tick so the loot
     * grant fires regardless of which UI tab the player is currently viewing. */
    this.advanceActiveGather();

    if (this.applyHarvestRespawns()) {
      this.emit();
    }

    /* === 2026-04-20 Tier D — allocation-free tick hot path ===
     *
     * `rates` is the reused `_scratchRates` instance field; cleared with
     * `for (const k in)` to preserve V8 hidden class shape (vs `= {}`
     * which discards the shape). Stale-zero entries skipped in the apply
     * loop below.
     *
     * `unlocked` comes from the cached `_cachedUnlockedSet` (lazily
     * rebuilt only when `state.unlockedCardIds` ref or length changes).
     *
     * `for (const k in record)` replaces `Object.entries(record)` — the
     * latter allocates an intermediate `[key, value][]` array every call.
     * Safe for plain data records (`automation.outputs`, `passiveGather`,
     * `upkeepPerMinute`) which have no inherited enumerable keys. */
    const rates = this._scratchRates;
    for (const k in rates) rates[k] = 0;
    const unlocked = this.getUnlockedCardSet();

    for (const slot of s.idleSlots) {
      if (!slot) continue;
      const c = cardById.get(slot);
      if (!c?.automation) continue;
      if (!unlocked.has(slot)) continue;
      const outputs = c.automation.outputs;
      const perSec = c.automation.perSecond;
      for (const k in outputs) {
        rates[k] = (rates[k] ?? 0) + outputs[k]! * perSec;
      }
    }

    const mult = this.getIdleAutomationMult();
    const inv = s.inventory;

    for (const k in rates) {
      const r = rates[k]!;
      /* Skip stale-zero entries from previous ticks — adding 0 to inventory
       * is a no-op math-wise but `(inv[k] ?? 0) + 0` materializes a `0`
       * value for keys that were never in inventory before, polluting the
       * save with explicit-zero rows. */
      if (r === 0) continue;
      inv[k] = (inv[k] ?? 0) + r * dt * mult;
    }

    for (const hid of s.hiredHelperIds) {
      const h = helperById.get(hid);
      if (!h?.passiveGather) continue;
      const pg = h.passiveGather;
      for (const k in pg) {
        inv[k] = (inv[k] ?? 0) + pg[k]! * dt;
      }
    }

    const minuteFrac = dt / 60;
    for (const hid of s.hiredHelperIds) {
      const h = helperById.get(hid);
      if (!h) continue;
      const foodKey = 'cooked_meat';
      const needFood = h.foodPerMinute * minuteFrac;
      if ((inv[foodKey] ?? 0) >= needFood) {
        inv[foodKey] -= needFood;
      } else {
        const berries = h.foodPerMinute * minuteFrac * 2;
        if ((inv.berries ?? 0) >= berries) inv.berries -= berries;
      }
      if (h.upkeepPerMinute) {
        const upkeep = h.upkeepPerMinute;
        for (const res in upkeep) {
          const take = upkeep[res]! * minuteFrac;
          if ((inv[res] ?? 0) >= take) inv[res] -= take;
        }
      }
    }

    this.applyHelperPlayerFeed(dt);

    /* Slightly slower than pre–travel-gather tuning so long harvests aren’t pure survival tax */
    if (!this.isTutorialSurvivalDrainPaused()) {
      s.hunger = Math.max(0, s.hunger - dt * 0.28);
      s.thirst = Math.max(0, s.thirst - dt * 0.36);
    }

    if (s.hunger <= 0 || s.thirst <= 0 || s.playerHp <= 0) {
      if (s.hunger <= 0 && s.thirst <= 0) {
        this.dieAndWipe(
          'You died',
          'Your hunger and thirst both hit zero. Permadeath — your run was wiped and a new camp has started. Hire helpers and keep food and water in stock to survive.',
        );
      } else if (s.hunger <= 0) {
        this.dieAndWipe(
          'You starved',
          'Your hunger reached zero. Permadeath — your run was wiped and a new camp has started. Eat before the bar empties; hired workers can feed you from your stockpile.',
        );
      } else if (s.thirst <= 0) {
        this.dieAndWipe(
          'You died of thirst',
          'Your thirst reached zero. Permadeath — your run was wiped and a new camp has started. Drink water regularly; workers can pass water from your inventory.',
        );
      } else {
        this.dieAndWipe(
          'Fatal injuries',
          'Your HP reached zero outside of battle. Permadeath — your run was wiped and a new camp has started.',
        );
      }
      return;
    }

    s.spoilAccumulatorMs += realDtMs;
    if (s.spoilAccumulatorMs >= 40_000) {
      s.spoilAccumulatorMs = 0;
      const hasCooler = (s.inventory.cooler ?? 0) > 0;
      const soft = hasCooler ? 0.96 : 0.9;
      const mid = hasCooler ? 0.97 : 0.93;
      const hard = hasCooler ? 0.98 : 0.95;
      for (const key of SPOILAGE_KEYS) {
        const q = s.inventory[key] ?? 0;
        if (q <= 0) continue;
        const mult = key === 'cooked_meat' ? soft : key === 'raw_meat' ? mid : hard;
        s.inventory[key] = q * mult;
      }
    }

    const maxM = this.getEffectiveMaxMana();
    const regen = 0.08 + this.getMagicManaRegenBonus();
    s.mana = Math.min(maxM, s.mana + dt * regen);

    s.lastRealMs = Date.now();
    if (this.applyMerchantSchedule()) {
      this.emit();
    }
    this.tickSaveMs += realDtMs;
    if (this.tickSaveMs >= 2500) {
      this.tickSaveMs = 0;
      saveState(this.state);
    }
  }

  /** Caravan is at camp (visit window). */
  isMerchantPresent(): boolean {
    return this.state.merchant.presentUntilMs > Date.now();
  }

  /** Whether an offer can be bought right now (stock, coin, prereqs). */
  merchantOfferAvailable(offerId: string): boolean {
    if (!this.isMerchantPresent()) return false;
    const o = merchantOfferById(offerId);
    if (!o) return false;
    if (this.state.pveWave < o.minPveWave) return false;
    const sold = this.state.merchant.soldThisVisit[offerId] ?? 0;
    if (sold >= o.maxPerVisit) return false;
    if (this.state.currency < o.price) return false;
    if (o.kind === 'inventory') return true;
    const cid = o.cardId!;
    const c = cardById.get(cid);
    if (!c) return false;
    if (this.state.unlockedCardIds.includes(cid)) return false;
    const unlocked = new Set(this.state.unlockedCardIds);
    return merchantCardPrereqsMet(c, unlocked);
  }

  /** Sell stackable camp resources for coin (only while merchant is visiting). */
  sellResourceToMerchant(resourceId: string, amount: number): boolean {
    if (!this.isMerchantPresent() || !canSellResourceToMerchant(resourceId)) return false;
    const have = this.state.inventory[resourceId] ?? 0;
    const take = Math.min(Math.max(0, amount), have);
    if (take <= 0) return false;
    const payout = merchantSellPayout(resourceId, take);
    if (payout <= 0) return false;
    const s = this.state;
    const coopSync = s.gameMode === 'coop' && s.onlineSession != null;
    s.inventory[resourceId] = have - take;
    s.currency += payout;
    if (coopSync) {
      getRoomHub().coopOp({ sub: { [resourceId]: take }, currencyDelta: payout });
    }
    this.emit();
    return true;
  }

  /** Buy a special bundle or card charter from the current visit. */
  buyMerchantOffer(offerId: string): boolean {
    if (!this.merchantOfferAvailable(offerId)) return false;
    const o = merchantOfferById(offerId)!;
    const s = this.state;
    const coopSync = s.gameMode === 'coop' && s.onlineSession != null;
    s.currency -= o.price;
    const sold = s.merchant.soldThisVisit[offerId] ?? 0;
    s.merchant.soldThisVisit[offerId] = sold + 1;
    if (o.kind === 'inventory' && o.grant) {
      for (const [k, v] of Object.entries(o.grant)) {
        s.inventory[k] = (s.inventory[k] ?? 0) + v;
      }
      if (coopSync) {
        getRoomHub().coopOp({ add: { ...o.grant }, currencyDelta: -o.price });
      }
    } else if (o.kind === 'card' && o.cardId) {
      this.applyMerchantCardUnlock(o.cardId);
      if (coopSync) {
        getRoomHub().coopOp({ currencyDelta: -o.price });
      }
    }
    this.emit();
    return true;
  }

  private applyMerchantCardUnlock(cardId: string): void {
    const c = cardById.get(cardId);
    if (!c) return;
    this.state.unlockedCardIds.push(cardId);
    if (c.unlocksStation) {
      this.state.stations = mergeStation(this.state.stations, c.unlocksStation);
    }
    if (c.battle && !this.state.combatDeck.includes(cardId)) {
      this.state.combatDeck.push(cardId);
    }
  }

  /** Wall-clock only — do not switch to sim hours; see `wanderingMerchant.ts` module doc. */
  private applyMerchantSchedule(): boolean {
    const now = Date.now();
    const m = this.state.merchant;
    let changed = false;
    if (m.presentUntilMs > 0 && now >= m.presentUntilMs) {
      m.presentUntilMs = 0;
      m.nextVisitAtMs = now + MERCHANT_GAP_MS;
      m.soldThisVisit = {};
      changed = true;
    }
    if (m.presentUntilMs <= 0 && now >= m.nextVisitAtMs) {
      m.presentUntilMs = now + MERCHANT_STAY_MS;
      m.soldThisVisit = {};
      changed = true;
    }
    return changed;
  }

  canUnlockCard(cardId: string): boolean {
    const c = cardById.get(cardId);
    if (!c) return false;
    if (this.state.unlockedCardIds.includes(cardId)) return false;
    const unlocked = new Set(this.state.unlockedCardIds);
    return prerequisitesMet(c, unlocked, this.state.inventory);
  }

  unlockCard(cardId: string): boolean {
    if (!this.canUnlockCard(cardId)) return false;
    const c = cardById.get(cardId)!;
    if (c.requiresItems && !spendInvForCardUnlock(this.state.inventory, c.requiresItems)) return false;
    this.state.unlockedCardIds.push(cardId);
    if (c.unlocksStation) {
      this.state.stations = mergeStation(this.state.stations, c.unlocksStation);
    }
    if (c.battle && !this.state.combatDeck.includes(cardId)) {
      this.state.combatDeck.push(cardId);
    }
    this.emit();
    return true;
  }

  nextIdleSlotUnlockCost(): number | null {
    return computeIdleSlotUnlockCost(this.state.idleSlots.length);
  }

  canUnlockIdleSlot(): boolean {
    const cost = this.nextIdleSlotUnlockCost();
    return cost != null && this.state.currency >= cost;
  }

  /** Spend coin to append one empty automation slot (up to IDLE_SLOT_MAX). */
  unlockIdleSlot(): boolean {
    const cost = this.nextIdleSlotUnlockCost();
    if (cost == null || this.state.currency < cost) return false;
    this.state.currency -= cost;
    this.state.idleSlots.push(null);
    this.emit();
    return true;
  }

  getIdleSlotCapacity(): { used: number; max: number } {
    return { used: this.state.idleSlots.length, max: IDLE_SLOT_MAX };
  }

  setIdleSlot(index: number, cardId: string | null): boolean {
    if (index < 0 || index >= this.state.idleSlots.length) return false;
    if (cardId !== null) {
      if (!this.state.unlockedCardIds.includes(cardId)) return false;
      const c = cardById.get(cardId);
      if (!c?.automation) return false;
    }
    this.state.idleSlots[index] = cardId;
    this.emit();
    return true;
  }

  availableRecipes(): RecipeDef[] {
    const unlocked = new Set(this.state.unlockedCardIds);
    const stations = effectiveStations(this.state);
    return recipes.filter((r) => {
      if (!recipeUnlocked(r, unlocked, this.state.inventory)) return false;
      if (!stations.has(r.station)) return false;
      return true;
    });
  }

  canCraft(recipeId: string): boolean {
    const r = recipeById.get(recipeId);
    if (!r) return false;
    if (!this.availableRecipes().some((x) => x.id === recipeId)) return false;
    return hasItems(this.state.inventory, r.inputs);
  }

  craft(recipeId: string): boolean {
    if (!this.canCraft(recipeId)) return false;
    const r = recipeById.get(recipeId)!;
    spendInv(this.state.inventory, r.inputs);
    addInv(this.state.inventory, r.outputs);
    for (const outId of Object.keys(r.outputs)) {
      if (isDurabilityItem(outId)) {
        ensureDurability(this.state, outId);
        this.state.toolDurability[outId] = 100;
      }
    }
    if (this.state.gameMode === 'coop' && this.state.onlineSession) {
      getRoomHub().coopOp({ sub: r.inputs, add: r.outputs });
    }
    this.emit();
    return true;
  }

  canHireHelper(helperId: string): boolean {
    return this.getHireBlockReason(helperId) === null;
  }

  /** If non-null, explains why Hire is disabled (except already hired — check separately in UI). */
  getHireBlockReason(helperId: string): string | null {
    const h = helperById.get(helperId);
    if (!h) return 'Unknown helper';
    if (this.state.hiredHelperIds.includes(helperId)) return 'Already hired';
    if (this.state.currency < h.hireCost) return `Need ${h.hireCost} ¤`;
    const unlocked = new Set(this.state.unlockedCardIds);
    if (h.requiresCards) {
      for (const id of h.requiresCards) {
        if (!unlocked.has(id)) return `Unlock card: ${cardById.get(id)?.name ?? id}`;
      }
    }
    if (h.requiresItems && !hasItems(this.state.inventory, h.requiresItems)) {
      const bits = Object.entries(h.requiresItems).map(([k, v]) => `${v}× ${k.replace(/_/g, ' ')}`);
      return `Need ${bits.join(', ')}`;
    }
    return null;
  }

  hireHelper(helperId: string): boolean {
    if (!this.canHireHelper(helperId)) return false;
    const h = helperById.get(helperId)!;
    this.state.currency -= h.hireCost;
    this.state.hiredHelperIds.push(helperId);
    if (this.state.gameMode === 'coop' && this.state.onlineSession) {
      getRoomHub().coopOp({ currencyDelta: -h.hireCost });
    }
    this.emit();
    return true;
  }

  /** Sum of flat damage from hired battle helpers (fist/weapon cards). */
  getBattleHelperDamageBonus(): number {
    let n = 0;
    for (const hid of this.state.hiredHelperIds) {
      const h = helperById.get(hid);
      n += h?.battleAssist?.damageBonus ?? 0;
    }
    return n;
  }

  /** Sum of flat block from hired battle helpers (enemy turn). */
  getBattleHelperBlockBonus(): number {
    let n = 0;
    for (const hid of this.state.hiredHelperIds) {
      const h = helperById.get(hid);
      n += h?.battleAssist?.blockBonus ?? 0;
    }
    return n;
  }

  /** Sort battle bar: fist first, then by tier / id. */
  sortCombatDeckDisplayOrder(ids: string[]): string[] {
    return [...ids].sort((a, b) => {
      if (a === 'c_fist') return -1;
      if (b === 'c_fist') return 1;
      const ca = cardById.get(a);
      const cb = cardById.get(b);
      const ta = ca?.tier ?? 99;
      const tb = cb?.tier ?? 99;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  }

  setCombatDeck(ids: string[]): void {
    const unlocked = new Set(this.state.unlockedCardIds);
    const next = ids.filter((id) => {
      const c = cardById.get(id);
      return c?.battle && unlocked.has(id);
    });
    if (next.length === 0) next.push('c_fist');
    this.state.combatDeck = next;
    this.emit();
  }

  startPveBattle(): boolean {
    if (this.state.battle) return false;
    const s = this.state;
    const duelOnline = s.onlineSession && (s.gameMode === 'pvp' || s.gameMode === 'deathmatch');
    if (duelOnline) {
      if (this.onlineSelfEliminated) return false;
      const rv = s.onlineSession?.pvpRival;
      if (!rv) return false;
      s.playerHp = Math.min(s.playerMaxHp, Math.max(1, Math.ceil(s.playerHp)));
      const seed = s.onlineSession?.seed ?? 0;
      const seedNote =
        s.onlineSession && seed !== 0 ? ` Session ${s.onlineSession.roomId} · seed ${seed}.` : '';
      const youSid = this.lastYourSessionId ?? '';
      const rivalSid = rv.sessionId;
      const youRow = this.lastRoomPlayers.find((p) => p.sessionId === youSid);
      const rivalRow = this.lastRoomPlayers.find((p) => p.sessionId === rivalSid);
      let youActFirst = true;
      if (youRow?.isHost) {
        youActFirst = true;
      } else if (rivalRow?.isHost) {
        youActFirst = false;
      } else if (youSid && rivalSid) {
        youActFirst = youSid < rivalSid;
      }
      const bs: BattleState = {
        mode: 'pvp',
        enemy: {
          id: 'pvp_rival',
          name: rv.displayName,
          maxHp: rv.maxHp,
          damage: 0,
          isPvP: true,
          rivalCharacterPresetId: rv.characterPresetId,
        },
        enemyHp: rv.maxHp,
        rivalSessionId: rv.sessionId,
        playerEnergy: STARTING_ENERGY,
        playerMaxEnergy: MAX_ENERGY,
        spellWard: 0,
        turn: youActFirst ? 'player' : 'enemy',
        turnNumber: 1,
        log: [
          `${rv.displayName} — ${s.gameMode === 'deathmatch' ? '3v3' : 'Hunter'} duel.${seedNote} Your camp vitals stay live; turns alternate — after you act, your rival strikes over the wire.${
            youActFirst ? '' : ' Opener acts first — your hand unlocks after their strike lands.'
          }`,
        ],
      };
      this.state.battle = bs;
      this.emit();
      setBattleMusicMode(true);
      return true;
    }
    const wave = s.pveWave;
    const n = pveEnemies.length;
    const seed = s.onlineSession?.seed ?? 0;
    const waveOffset = seed !== 0 ? (Math.imul(seed, 1103515245) >>> 0) % n : 0;
    /* Witch scheduling — every WITCH_BATTLE_INTERVAL clean PvE wins, the next encounter
     * is the next pending witch (cori → jenny → kristin) instead of a regular enemy.
     * Difficulty scales the same as regular PvE, so a player who hits the threshold late
     * gets a tougher witch. See `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §4. */
    const isOnlineDuel = s.onlineSession && (s.gameMode === 'pvp' || s.gameMode === 'deathmatch');
    const cycles = Math.floor(wave / n);
    const scale = Math.pow(1.18, cycles) * (1 + wave * 0.028);
    const competitive = isOnlineDuel ? 1.12 : 1;
    let base: EnemyDef;
    const nextWitchId = !isOnlineDuel && s.witchBattlesUntilNext <= 0 ? this.getNextWitchId() : null;
    if (nextWitchId) {
      const meta = WITCH_ENEMY_BY_SHARD.get(nextWitchId);
      base = (meta?.enemy ?? pveEnemies[0]) as EnemyDef;
    } else {
      const enemyIdx = (wave + waveOffset) % n;
      base = (pveEnemies[enemyIdx] ?? pveEnemies[0]) as EnemyDef;
    }
    const maxHp = Math.max(1, Math.round(base.maxHp * scale * competitive));
    const damage = Math.max(1, Math.round(base.damage * scale * competitive));
    const enemy = { ...base, maxHp, damage };
    s.playerHp = Math.min(s.playerMaxHp, Math.max(1, Math.ceil(s.playerHp)));
    const duel = s.gameMode === 'pvp' || s.gameMode === 'deathmatch';
    const seedNote =
      s.onlineSession && seed !== 0 ? ` Session ${s.onlineSession.roomId} · seed ${seed}.` : '';
    const bs: BattleState = {
      mode: duel ? 'pvp' : 'pve',
      enemy: { ...enemy },
      enemyHp: enemy.maxHp,
      playerEnergy: STARTING_ENERGY,
      playerMaxEnergy: MAX_ENERGY,
      spellWard: 0,
      turn: 'player',
      turnNumber: 1,
      log: [
        duel
          ? `${enemy.name} — ${s.gameMode === 'deathmatch' ? 'Bracket' : 'Hunter'} duel · encounter ${wave + 1}${wave > 0 ? ` (scaled after ${wave} win${wave === 1 ? '' : 's'})` : ''}.${seedNote} Your camp vitals stay live during the fight.`
          : `${enemy.name} — encounter ${wave + 1}${wave > 0 ? ` (scaled after ${wave} win${wave === 1 ? '' : 's'})` : ''}.${seedNote} Your HP, hunger, and thirst are your real camp stats — they keep changing during this fight.`,
      ],
    };
    this.state.battle = bs;
    this.emit();
    setBattleMusicMode(true);
    return true;
  }

  battlePlayCard(cardId: string): void {
    const b = this.state.battle;
    if (!b || b.turn !== 'player') return;
    const c = cardById.get(cardId);
    if (!c?.battle) return;
    if (!this.state.combatDeck.includes(cardId)) return;
    if (c.battle.attackStyle !== 'fist' && !this.playerHasWeaponStyle(c.battle.attackStyle)) {
      b.log.push('You need a weapon or focus for that.');
      this.emit();
      return;
    }
    const manaCost = c.battle.manaCost ?? 0;
    if (manaCost > 0 && this.state.mana < manaCost) {
      b.log.push('Not enough mana.');
      this.emit();
      return;
    }
    if (b.playerEnergy < c.battle.energyCost) {
      b.log.push('Not enough energy.');
      this.emit();
      return;
    }
    if (manaCost > 0) this.state.mana -= manaCost;
    b.playerEnergy -= c.battle.energyCost;

    const style = c.battle.attackStyle;
    let pvpOutgoingDamage = 0;
    if (style === 'spell') {
      const parts: string[] = [];
      const sdmg = c.battle.damage ?? 0;
      if (sdmg > 0) {
        const arc = this.getArcaneSpellDamageBonus();
        const total = sdmg + arc;
        b.enemyHp -= total;
        pvpOutgoingDamage = total;
        parts.push(`${total} arcane${arc > 0 ? ` (+${arc})` : ''}`);
      }
      const sheal = c.battle.heal ?? 0;
      if (sheal > 0) {
        const before = this.state.playerHp;
        this.state.playerHp = Math.min(this.state.playerMaxHp, this.state.playerHp + sheal);
        parts.push(`+${Math.ceil(this.state.playerHp - before)} HP`);
      }
      const ward = c.battle.wardFlat ?? 0;
      if (ward > 0) {
        b.spellWard = (b.spellWard ?? 0) + ward;
        parts.push(`ward +${ward}`);
      }
      b.log.push(`${c.name}: ${parts.join(', ') || 'chant'}.`);
    } else {
      const base = c.battle.damage ?? 0;
      const bonus = style === 'fist' || style === 'weapon' ? this.getWeaponDamageBonus() : 0;
      const helperDmg = style === 'fist' || style === 'weapon' ? this.getBattleHelperDamageBonus() : 0;
      const dmg = base + bonus + helperDmg;
      b.enemyHp -= dmg;
      pvpOutgoingDamage = dmg;
      if (style === 'weapon' || style === 'fist') {
        const w = this.state.equipment.weapon;
        if (w) {
          const sw = SWORD_BATTLE_WEAR[w];
          if (sw !== undefined) this.applyToolWear(w, sw);
          else {
            const aw = AXE_BATTLE_WEAR[w];
            if (aw !== undefined) this.applyToolWear(w, aw);
          }
        }
      }
      const hb = helperDmg > 0 ? ` (+${helperDmg} hands)` : '';
      b.log.push(`${c.name} hits for ${dmg}${hb}.`);
    }

    if (b.enemyHp <= 0) {
      b.turn = 'victory';
      if (b.mode === 'pvp' && b.rivalSessionId) {
        getRoomHub().pvpRivalDefeated(b.rivalSessionId);
        b.log.push('You win the duel!');
        this.state.currency += 32 + this.state.pveWave * 10;
        b.log.push('Reward: bragging rights and a purse from the bracket.');
        this.state.playerHp = Math.min(this.state.playerMaxHp, Math.max(1, Math.ceil(this.state.playerHp)));
        this.state.pveWave += 1;
      } else {
        b.log.push('Victory!');
        this.state.currency += 28 + this.state.pveWave * 12;
        const meatLoot = b.enemy.id === 'e_wolf' ? 2 : 1;
        this.state.inventory.raw_meat = (this.state.inventory.raw_meat ?? 0) + meatLoot;
        b.log.push(`Loot: +${meatLoot} raw meat`);
        this.state.playerHp = Math.min(this.state.playerMaxHp, Math.max(1, Math.ceil(this.state.playerHp)));
        this.state.pveWave += 1;
        /* Witch defeat → record the shard, drop a tangible inventory item, reset the
         * counter so the next ~15 fights are regular PvE again. Per
         * `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §4. Regular kills decrement the counter
         * toward the next witch encounter. */
        const witchMeta = WITCH_ENEMY_BY_ID.get(b.enemy.id);
        if (witchMeta) {
          this.recordShardDrop(witchMeta.shardId);
          b.log.push(`The ${witchMeta.enemy.name} drops a shard of your talisman. (${this.getShardCount()}/3)`);
        } else {
          this.decrementWitchCounter();
        }
      }
      this.emit();
      return;
    }
    if (b.mode === 'pvp' && b.rivalSessionId) {
      getRoomHub().pvpStrike({
        toSessionId: b.rivalSessionId,
        damage: pvpOutgoingDamage,
        cardName: c.name,
      });
    }
    b.turn = 'enemy';
    this.emit();
  }

  /** Crafted consumable: restore HP, consume 1 from inventory, then enemy turn (PvE player phase only). */
  battleUseBandage(): void {
    this.battleUseHealItem('bandage', BATTLE_HEAL_BANDAGE);
  }

  battleUseStim(): void {
    this.battleUseHealItem('stim', BATTLE_HEAL_STIM);
  }

  private battleUseHealItem(itemId: 'bandage' | 'stim', heal: number): void {
    const b = this.state.battle;
    if (!b || b.turn !== 'player') return;
    if ((this.state.inventory[itemId] ?? 0) < 1) {
      b.log.push(`No ${itemId === 'bandage' ? 'bandages' : 'stims'} left.`);
      this.emit();
      return;
    }
    if (this.state.playerHp >= this.state.playerMaxHp) {
      b.log.push('Already at full HP.');
      this.emit();
      return;
    }
    this.state.inventory[itemId] = (this.state.inventory[itemId] ?? 0) - 1;
    const before = this.state.playerHp;
    this.state.playerHp = Math.min(this.state.playerMaxHp, this.state.playerHp + heal);
    const gained = this.state.playerHp - before;
    const label = itemId === 'bandage' ? 'Bandage' : 'Stim';
    b.log.push(`${label}: +${Math.ceil(gained)} HP.`);
    b.turn = 'enemy';
    if (b.mode === 'pvp' && b.rivalSessionId) {
      getRoomHub().pvpStrike({
        toSessionId: b.rivalSessionId,
        damage: 0,
        cardName: label,
      });
    }
    this.emit();
  }

  battleEndTurn(): void {
    const b = this.state.battle;
    if (!b || b.turn !== 'enemy') return;
    if (b.mode === 'pvp') return;
    const mit = this.getArmorMitigation();
    const raw = b.enemy.damage;
    const blockFlat = this.getBattleHelperBlockBonus();
    const afterBlock = Math.max(1, raw - blockFlat);
    let incoming = afterBlock;
    let ward = b.spellWard ?? 0;
    let wardUsed = 0;
    if (ward > 0) {
      const absorbed = Math.min(ward, incoming);
      wardUsed = absorbed;
      ward -= absorbed;
      incoming -= absorbed;
      b.spellWard = ward;
    }
    const reduced =
      incoming <= 0
        ? 0
        : Math.max(1, Math.floor(incoming * (1 - Math.min(0.45, mit * 0.025))));
    this.state.playerHp -= reduced;
    if (this.state.equipment.shield === 'wooden_shield') this.applyToolWear('wooden_shield', 1.2);
    const blkNote = blockFlat > 0 ? `, −${blockFlat} hands` : '';
    const wardNote = wardUsed > 0 ? `, −${wardUsed} ward` : '';
    b.log.push(
      `${b.enemy.name} hits you for ${reduced} (${mit} armor${blkNote}${wardNote}). You are now at ${Math.max(0, Math.ceil(this.state.playerHp))} / ${this.state.playerMaxHp} HP.`,
    );
    if (this.state.playerHp <= 0) {
      const enemyName = b.enemy.name;
      this.state.playerHp = 0;
      b.turn = 'defeat';
      b.pendingPermadeath = {
        headline: 'Defeated in battle',
        body: `You were defeated by ${enemyName}. Your HP reached 0 in combat — the same HP as shown in the top bar. Permadeath: your entire run was wiped and a new camp has started.`,
      };
      b.log.push('You collapse — the fight is over.');
      this.emit();
      return;
    }
    b.turnNumber += 1;
    b.playerEnergy = Math.min(b.playerMaxEnergy, b.playerEnergy + 1);
    b.turn = 'player';
    this.emit();
  }

  battleClose(): void {
    const b = this.state.battle;
    if (b && b.turn !== 'victory' && b.turn !== 'defeat') {
      this.state.playerHp = Math.max(1, Math.ceil(this.state.playerHp));
    }
    this.state.battle = null;
    this.emit();
    setBattleMusicMode(false);
  }

  /** Completes permadeath after the battle dock finishes the player death clip. */
  finishBattlePermadeath(): void {
    const b = this.state.battle;
    if (!b?.pendingPermadeath) return;
    const { headline, body, pvpStayInLobby } = b.pendingPermadeath;
    if (pvpStayInLobby) {
      this.pvpDieResetStayInLobby(headline, body);
    } else {
      this.dieAndWipe(headline, body);
    }
  }

  private playerHasWeaponStyle(style: 'fist' | 'weapon' | 'spell'): boolean {
    if (style === 'fist') return true;
    const inv = this.state.inventory;
    if (style === 'weapon')
      return (EQUIPPABLE_WEAPON_IDS as readonly string[]).some((id) => (inv[id] ?? 0) >= 1);
    if (style === 'spell') return this.state.unlockedCardIds.includes(MAGIC_ENTRY_CARD_ID);
    return false;
  }

  /** Hunger/thirst passive decay is off during intro + guided steps; skip/completion resumes normal survival. */
  private isTutorialSurvivalDrainPaused(): boolean {
    const st = this.state.tutorial.status;
    return st === 'not_started' || st === 'active';
  }

  getTutorial(): TutorialState {
    return this.state.tutorial;
  }

  tutorialStartGuided(): void {
    this.state.tutorial = {
      version: 1,
      status: 'active',
      stepId: 'hud_meters',
      flags: {},
    };
    this.emit();
  }

  tutorialSkip(): void {
    this.state.tutorial = {
      version: 1,
      status: 'skipped',
      stepId: 'done',
      flags: this.state.tutorial.flags,
    };
    this.emit();
  }

  tutorialSetStep(stepId: string): void {
    if (this.state.tutorial.status !== 'active') return;
    this.state.tutorial = {
      ...this.state.tutorial,
      stepId,
    };
    this.emit();
  }

  tutorialMarkBattleCombatHintShown(): void {
    const t = this.state.tutorial;
    if (t.status !== 'active') return;
    this.state.tutorial = {
      ...t,
      flags: { ...t.flags, battleCombatHintShown: true },
    };
    this.emit();
  }

  tutorialComplete(): void {
    this.state.tutorial = {
      version: 1,
      status: 'completed',
      stepId: 'done',
      flags: this.state.tutorial.flags,
    };
    this.emit();
  }

  reset(): void {
    setBattleMusicMode(false);
    this.activeGather = null;
    getRoomHub().leaveRoom();
    /* === 2026-04-21 don't re-arm intro cutscene on reset ===
     *
     * Previously this removed `idle-craft-intro-cutscene-seen-v1` so a
     * Reset / "New expedition" would replay the full intro chain (curse +
     * shattering, ~2 min of mandatory playback). The narrative framing was
     * "reset = the curse re-takes you", but in practice this ate ~2 min
     * every time a Vibe Jam judge tried a fresh run, and felt like a bug
     * because the rest of the boot path treats "you've completed the intro
     * once" as a permanent device-level fact (the warm-visit skip on
     * refresh works exactly that way). The flag now means "this player
     * has seen the cinematic on this device — don't show it again unless
     * they explicitly clear localStorage" regardless of save state. */
    this.state = createInitialState();
    this.emit();
  }
}

function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const migrated = migrateLoaded(p);
    if (!Array.isArray(migrated.idleSlots)) migrated.idleSlots = Array(IDLE_SLOT_INITIAL).fill(null);
    if (migrated.idleSlots.length > IDLE_SLOT_MAX) migrated.idleSlots = migrated.idleSlots.slice(0, IDLE_SLOT_MAX);
    while (migrated.idleSlots.length < IDLE_SLOT_INITIAL) migrated.idleSlots.push(null);
    if (!migrated.equipment) migrated.equipment = defaultEquipment();
    else if (migrated.equipment.pick === undefined) migrated.equipment.pick = null;
    if (!migrated.toolDurability) migrated.toolDurability = {};
    if (migrated.lastDeathHeadline === undefined) migrated.lastDeathHeadline = null;
    if (migrated.lastDeathBody === undefined) migrated.lastDeathBody = null;
    if (!migrated.gameMode) migrated.gameMode = 'solo';
    if (migrated.onlineSession === undefined) migrated.onlineSession = null;
    if (!migrated.characterPresetId) migrated.characterPresetId = DEFAULT_CHARACTER_PRESET_ID;
    if (!migrated.tutorial || typeof migrated.tutorial !== 'object') {
      migrated.tutorial = defaultTutorialCompleted();
    }
    migrated.harvestPatches = normalizeHarvestPatches(migrated.harvestPatches);
    migrated.harvestMastery = normalizeHarvestMastery(migrated.harvestMastery);
    migrated.merchant = normalizeMerchantState(migrated.merchant, Date.now());
    return migrated;
  } catch {
    return null;
  }
}

/* ============================================================================
 * Debounced persistence
 * ============================================================================
 *
 * `saveState` is called from EVERY mutating store method — 20+ call sites
 * (mana spend, damage taken, inventory change, equip slot, etc.). Each call
 * does a synchronous `JSON.stringify(state)` + `localStorage.setItem`, both
 * O(state-size) and main-thread-blocking. With a populated state object
 * (cards, inventory, helpers, placed pieces) a single save can take 15-50 ms.
 *
 * **2026-04 fix.** Awakened combat fires saves at high frequency:
 *   - Player attacks (LMB)        → useMana → save
 *   - Each mob hits player (~1 Hz) → damagePlayerInAwakened → save
 *   - Each mob takes damage        → damageAwakenedMob → save
 *   - Mob kill                     → grantCurrency / inventory mutation → save
 * With 6 mobs alive and ARPG-pace combat that's 6-10 saves per second of a
 * multi-KB state object. Symptom: visible stutter every time the player
 * hits or is hit (the user-reported "aspects freeze when animals attack and
 * I attack them"). The save itself isn't doing anything wrong; it's just
 * being called way more often than persistence actually requires.
 *
 * Solution: coalesce all `saveState(s)` calls within a `SAVE_DEBOUNCE_MS`
 * window into a single deferred write. The in-memory state is already
 * authoritative for game logic + UI — the localStorage copy is purely for
 * crash recovery, where losing 250 ms of progress is perfectly acceptable.
 * Page-unload + tab-hide events flush the pending save synchronously so a
 * normal browser close doesn't lose anything.
 *
 * Crash-recovery semantics: in the worst case (browser process kill mid-
 * combat) the player loses up to ~250 ms of state changes. For combat
 * events (HP / mana ticks) this is invisible. For "important" actions
 * (purchases, builds, level-ups) the player is typically not killing the
 * tab in the same 250 ms window, and the next state mutation flushes
 * within the debounce window anyway.
 */
const SAVE_DEBOUNCE_MS = 250;
let pendingSaveState: GameState | null = null;
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingSave(): void {
  if (pendingSaveTimer != null) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  if (pendingSaveState != null) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(pendingSaveState));
    } catch {
      /* private mode / quota exceeded — best-effort; UI continues from in-mem state. */
    }
    pendingSaveState = null;
  }
}

function saveState(s: GameState): void {
  /* Always update the latest snapshot reference — the deferred timer will
   * write whichever state was most recent at fire time. This way a chain
   * of 20 mutations within 250 ms produces ONE write of the final state
   * instead of 20 sequential writes of intermediate states. */
  pendingSaveState = s;
  if (pendingSaveTimer != null) return;
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    if (pendingSaveState != null) {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(pendingSaveState));
      } catch {
        /* private mode / quota exceeded — silent. */
      }
      pendingSaveState = null;
    }
  }, SAVE_DEBOUNCE_MS);
}

/* Flush on page unload + tab hide so a normal browser close persists the
 * latest state. `pagehide` fires reliably across browsers (including iOS
 * Safari, where `beforeunload` is unreliable); `visibilitychange` covers
 * the user backgrounding the tab. Both routes call the same synchronous
 * flush — duplicate calls are a no-op once the timer is cleared. */
if (typeof window !== 'undefined') {
  const flushOnLeave = () => flushPendingSave();
  window.addEventListener('pagehide', flushOnLeave);
  window.addEventListener('beforeunload', flushOnLeave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });
}

export { cardDefs as allCards, recipes as allRecipes, helpers as allHelpers, pveEnemies as allEnemies };
