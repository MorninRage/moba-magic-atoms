import type { HarvestMasteryState } from '../data/rpgHarvestMastery';
import type { HarvestPatchesState } from '../world/idleCraftHarvestNodes';

/** Deck / progression trees */
export type DeckTree = 'building' | 'survival' | 'combat' | 'magic';

/**
 * Top-level "what reality is the player in" mode. `'deck'` = tab-driven idle-craft UI
 * (the Vanguard's dream-prison). `'awakened'` = full-screen 3D free-roam world (the
 * Vanguard has woken from the curse). See `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` and
 * `LORE.md` §6 + §10 for the diegetic framing.
 */
export type RealmMode = 'deck' | 'awakened';

/** Three Witches Guild members from `intro_the_shattering` cutscene; each holds one talisman shard. */
export type WitchShardId = 'cori' | 'jenny' | 'kristin';

/** Set of shards recovered. All three true → `getCanBreakFree()` returns true. */
export type ShardState = Record<WitchShardId, boolean>;

/** Start-flow mode picker — online modes ship with Fly/lobby work (see contest plan Part B). */
export type GameMode = 'solo' | 'coop' | 'pvp' | 'deathmatch';

/** Procedural survivor visual preset (dock LPCA palette pass). */
export type CharacterPresetId =
  | 'vanguard'
  | 'artisan'
  | 'wayfarer'
  | 'geomancer'
  | 'ridge_runner'
  | 'ash_seer'
  | 'copper_jack'
  | 'frost_line';

export type CraftStation = 'hand' | 'campfire' | 'workbench' | 'forge' | 'kitchen';

export interface RecipeDef {
  id: string;
  name: string;
  description: string;
  station: CraftStation;
  timeSeconds: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  /** Card ids that must be unlocked before this recipe appears */
  requiresCards?: string[];
  /**
   * Items the player must have *ever* crafted / acquired (counted by current inventory)
   * before this recipe appears. Used by the crystal staff/wand line so the next tier
   * unlocks once the previous staff exists. Phase D — `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §9.
   */
  requiresItems?: Record<string, number>;
}

export interface CardDef {
  id: string;
  name: string;
  description: string;
  tree: DeckTree;
  /** Lore / UI tier */
  tier: number;
  unlockedByDefault?: boolean;
  requiresCards?: string[];
  requiresItems?: Record<string, number>;
  /** When unlocked, passively adds to idle gather (per second) */
  automation?: {
    outputs: Record<string, number>;
    perSecond: number;
  };
  /** Unlocks these recipe ids when card is owned */
  unlocksRecipes?: string[];
  /** Unlocks a craft station when owned */
  unlocksStation?: CraftStation;
  /** Added to base max mana while this card is unlocked */
  maxManaBonus?: number;
  /** Extra mana regen per second while unlocked */
  manaRegenBonus?: number;
  /** Combat-only */
  battle?: {
    energyCost: number;
    /** Spells spend mana in addition to energy (optional). */
    manaCost?: number;
    damage?: number;
    heal?: number;
    /** Absorbs this much from the next enemy hit (after helper block), then remaining ward carries over. */
    wardFlat?: number;
    /** 'fist' | 'weapon' | 'spell' — fist only until gear exists */
    attackStyle: 'fist' | 'weapon' | 'spell';
  };
}

export type HelperRole =
  | 'general'
  | 'gathering'
  | 'industry'
  | 'kitchen'
  | 'battle'
  | 'arcane';

export interface HelperBattleAssist {
  /** Flat damage added when you play fist or weapon attack cards */
  damageBonus?: number;
  /** Flat subtracted from enemy hit damage before armor (min 1 final hit) */
  blockBonus?: number;
}

/** While hired, tries to restore your hunger/thirst from stockpile (cooked meat → berries; water). */
export interface HelperFeedPlayer {
  hungerPerMinute?: number;
  thirstPerMinute?: number;
}

export interface HelperDef {
  id: string;
  name: string;
  description: string;
  hireCost: number;
  /**
   * UI “speed” label — should match `1 + idleBonus` when `idleBonus` is set.
   * If only `speedMult` is set (legacy), idle math uses `speedMult - 1` as additive bonus.
   */
  speedMult: number;
  /**
   * Additive slice toward idle automation: combined mult = 1 + min(sum(idleBonus), cap).
   * When omitted, uses `speedMult - 1`.
   */
  idleBonus?: number;
  /** Direct resources per second (not multiplied by idle cards); extra “hands” gathering */
  passiveGather?: Record<string, number>;
  /** Food consumed per real minute (abstract “rations”) */
  foodPerMinute: number;
  /** Extra resources consumed per minute */
  upkeepPerMinute?: Record<string, number>;
  /** Hire screen grouping */
  role: HelperRole;
  /** Passively feeds you from inventory (uses same rates as manual eat/drink). */
  feedPlayer?: HelperFeedPlayer;
  /** Optional PvE assists while hired */
  battleAssist?: HelperBattleAssist;
  /** Must have these card ids unlocked to hire */
  requiresCards?: string[];
  /** Must have these items in inventory to hire (not consumed) */
  requiresItems?: Record<string, number>;
}

export interface EnemyDef {
  id: string;
  name: string;
  maxHp: number;
  damage: number;
  isPvP: boolean;
  /** Human rival look in the battle dock when id is pvp_rival */
  rivalCharacterPresetId?: CharacterPresetId;
}

export interface BattleState {
  mode: 'pve' | 'pvp';
  enemy: EnemyDef;
  enemyHp: number;
  /** Opponent session for online PvP strikes (server relay). */
  rivalSessionId?: string;
  /** Player HP / max HP / hunger / thirst use GameState — not duplicated here */
  playerEnergy: number;
  playerMaxEnergy: number;
  /** Remaining absorption from defensive spells (applied before armor). */
  spellWard: number;
  turn: 'player' | 'enemy' | 'victory' | 'defeat';
  turnNumber: number;
  log: string[];
  /**
   * When the player dies in PvE, permadeath wipe runs after the dock death animation finishes.
   * See {@link GameStore.finishBattlePermadeath}.
   */
  pendingPermadeath?: { headline: string; body: string; pvpStayInLobby?: boolean };
}

/** Weapon / shield / gathering pick */
export type EquipSlot = 'weapon' | 'armor' | 'shield' | 'pick';

export interface EquipmentState {
  weapon: string | null;
  armor: string | null;
  shield: string | null;
  /** Active pick for mining gathers (must still be in inventory). */
  pick: string | null;
}

/** Set when the host launches an online run from the lobby (room id + shared seed). */
export type OnlineSessionMeta = {
  roomId: string;
  seed: number;
  /** 3v3 / deathmatch team from lobby (optional). */
  team?: 0 | 1;
  /** Display names of everyone who was in the room at launch (co-op / social). */
  partyRoster?: string[];
  /** Set when server assigns your duel opponent (PvP / 3v3). */
  pvpRival?: {
    sessionId: string;
    displayName: string;
    characterPresetId: CharacterPresetId;
    maxHp: number;
  };
};

/** First-run guided tour — persisted on save. */
export type TutorialStatus = 'not_started' | 'active' | 'completed' | 'skipped';

export interface TutorialState {
  version: 1;
  status: TutorialStatus;
  /** Current step id for active tours; `intro` until user chooses guided/skip. */
  stepId: string;
  /** One-shot hints so optional battle UI doesn’t spam. */
  flags?: { battleCombatHintShown?: boolean };
}

/** Caravan schedule + per-visit purchase limits for special stock. */
export type MerchantState = {
  /** If > Date.now(), merchant is at camp (visit end time). 0 = absent. */
  presentUntilMs: number;
  /** When the next visit begins (ignored while a visit is active). */
  nextVisitAtMs: number;
  /** Offer id → count bought this visit. */
  soldThisVisit: Record<string, number>;
};

export interface GameState {
  version: number;
  /** Selected from start flow: solo is local; online modes use the lobby then the same expedition loop. */
  gameMode: GameMode;
  /** Present after a hosted launch from Fly lobby; cleared for fresh solo or on reset. */
  onlineSession: OnlineSessionMeta | null;
  /** Visual preset for procedural avatar (character dock). */
  characterPresetId: CharacterPresetId;
  inventory: Record<string, number>;
  currency: number;
  mana: number;
  maxMana: number;
  /** Persistent vitals — same values in battle (no separate combat HP pool) */
  playerHp: number;
  playerMaxHp: number;
  /** 0–100, decays over time; food restores */
  hunger: number;
  thirst: number;
  unlockedCardIds: string[];
  /** Cards slotted for idle automation; length is IDLE_SLOT_INITIAL..IDLE_SLOT_MAX after unlocks */
  idleSlots: (string | null)[];
  combatDeck: string[];
  hiredHelperIds: string[];
  /** Stations unlocked beyond defaults */
  stations: CraftStation[];
  lastRealMs: number;
  battle: BattleState | null;
  /** Highest PvE wave cleared */
  pveWave: number;
  equipment: EquipmentState;
  /** Durability 0–100 per tool id; breaks at 0 */
  toolDurability: Record<string, number>;
  /** Ms toward spoilage tick */
  spoilAccumulatorMs: number;
  /** Modal title after permadeath (e.g. "Defeated in battle") */
  lastDeathHeadline: string | null;
  /** How you died; cleared when player dismisses modal */
  lastDeathBody: string | null;
  /** Guided tutorial progress (v14+). */
  tutorial: TutorialState;
  /** Persistent manual-gather slots by resource kind (v15+); optional vein seal + strain (v16+). */
  harvestPatches: HarvestPatchesState;
  /** Per-vein RPG mastery tiers (v16+). */
  harvestMastery: HarvestMasteryState;
  /** Wandering merchant visits (v17+). */
  merchant: MerchantState;
  /** Top-level realm: `'deck'` (idle-craft UI / dream-prison) or `'awakened'` (free-roam 3D). v18+. */
  realmMode: RealmMode;
  /** Talisman shards recovered from defeated witches. All three true → spell can break. v18+. */
  shards: ShardState;
  /**
   * Countdown to the next witch encounter. Decremented on PvE victory only when the
   * upcoming encounter would be a regular enemy AND a witch is still pending. Reset
   * to {@link WITCH_BATTLE_INTERVAL} after any witch defeat. v18+.
   */
  witchBattlesUntilNext: number;
  /**
   * Order witches will appear in: front of the array is the next one. Pop from front
   * when defeated. Default `['cori', 'jenny', 'kristin']` (matches `intro_the_shattering`
   * cutscene order + `LORE.md` §8 voice trio). v18+.
   */
  witchOrder: WitchShardId[];
  /**
   * Total magic crystals harvested from the world (Phase D — free-roam crystal nodes).
   * Each crystal contributes +0.5 to `getEffectiveMaxMana()` so the player visibly grows
   * in spell pool as they reclaim power. v18+.
   */
  magicCrystalsHarvested: number;
  /**
   * Awakened-mode placed log-cabin pieces (Phase 1 of the base-building system — see
   * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`). Each entry holds a piece's world XZ,
   * Y (snap-resolved at place-time), rotation, current/max HP, material tier, and a
   * reserved `crystalWrap` slot left null in Phase 1 so adding wraps in Phase 3 won't
   * trigger another `STATE_VERSION` bump. v19+.
   */
  placedCabinPieces: PlacedCabinPiece[];
  /** Monotonic counter for assigning fresh `PlacedCabinPiece.id`s across a session. v19+. */
  placedCabinPieceCounter: number;
  /**
   * Awakened-mode placed craft stations (campfire, workbench, future forge / kitchen).
   * Multi-instance: the player can place many campfires at any XZ in the awakened
   * realm via Build mode. Each placement consumes the recipe's materials directly
   * (mirrors `placedCabinPieces` — no inventory token round-trip). Empty array
   * when the player has never placed a station; dream-mode players never see this
   * field populated (Build mode only runs in awakened realm).
   *
   * The dream-mode dock-yard campfire / workbench (rendered by
   * `characterScenePreview` from `state.stations` + `inventory[campfire/workbench]`)
   * is COMPLETELY SEPARATE — that's the dock-prison's fixed camp slot, untouched
   * by this awakened-mode placement. v24+. Replaces the dead-on-arrival
   * `awakenedStationPositions` field from v23 (deleted in the v24 migration).
   */
  placedCraftStations: PlacedCraftStation[];
  /** Monotonic counter for assigning fresh `PlacedCraftStation.id`s across a session. v24+. */
  placedCraftStationCounter: number;
  /**
   * Awakened-mode equipped offensive spell (CardDef id, e.g. `c_spell_ember_bolt`).
   * Drives `castMagic`'s damage + manaCost when LMB is pressed with a wand/staff
   * equipped (or with the dev magic flag on). Null = use the staff's intrinsic
   * baseline damage (existing fallback path). Auto-set to the first unlocked offense
   * spell when the player crafts one, but the player can re-pick via the hotbar's
   * Offensive slot click. v20+.
   */
  equippedOffensiveSpellId: string | null;
  /**
   * Awakened-mode equipped defensive spell (CardDef id, e.g. `c_spell_glancing_ward`).
   * Activates the magical ward bubble when held (RMB while a defensive spell is
   * equipped — replaces the shield's flat damage reduction). Drains mana while
   * active. Null = no ward; RMB falls back to shield-block (if shield equipped).
   * v20+.
   */
  equippedDefensiveSpellId: string | null;
  /**
   * Awakened-mode LMB combat mode toggle (M key / shortcut-bar button).
   *   - `'hit'`   : LMB does melee only — never casts magic, even with a spell
   *                 equipped. Use when the player wants to conserve mana or play
   *                 a pure melee build.
   *   - `'magic'` : LMB casts the equipped offensive spell AND swings melee at
   *                 close range simultaneously. The spell handles long-range
   *                 damage; the swing chips anyone who closed in. The default
   *                 once magic is unlocked, since equipping a spell is an
   *                 explicit "use magic" choice.
   * Only meaningful when an offensive spell is equipped — otherwise LMB falls
   * back to the legacy weapon-based dispatch regardless of mode. v21+.
   */
  combatMode: 'hit' | 'magic';
  /**
   * 6-slot consumable hotbar (1-6 number keys in awakened mode). Each slot holds
   * an inventory item id (e.g. `'berries'`, `'cooked_meat'`, `'water'`) or `null`
   * for an empty slot. Pressing the matching number key consumes one of that item
   * from `inventory` via `useHotbarSlot(idx)` — fires the existing `consumeFood`
   * / `drinkWater` / etc. flow so vital restoration + SFX layer in cleanly.
   *
   * Length is fixed at 6 (matches the visible 1-6 key labels); migration ensures
   * legacy saves get a fresh 6-slot null array. Players assign slots via the
   * shortcut bar (click empty slot → picker modal listing inventory consumables).
   * v22+.
   */
  hotbarSlots: (string | null)[];
  /**
   * When true and the player has at least one torch, night dock / gather idle can show
   * the lit hand torch (L key in awakened toggles; persisted). Craft-at-fire and
   * consume clips can still force a lit torch at night when unequipped. v25+.
   */
  torchEquipped: boolean;
}

/* ============================================================================
 * Awakened-mode base building (Phase 1 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md)
 * ============================================================================ */

/**
 * Piece archetypes in the log-cabin builder. Mirrors GoE's BuildModeSystem piece
 * categories but trimmed to the log-cabin vocabulary the Vanguard Wizard recovers in
 * the awakened realm. Phase 1 ships an MVP subset of geometry; the type already lists
 * every kind the master plan locks so future phases don't have to widen the union.
 */
export type CabinPieceKind =
  | 'foundation'
  | 'pillar'
  | 'wall_solid'
  | 'wall_window'
  | 'wall_doorway'
  | 'door'
  | 'floor'
  | 'ceiling'
  | 'roof_slope'
  | 'roof_peak'
  | 'stairs'
  | 'gate'
  | 'ladder';

/**
 * Material reskin tier. T0/T1 are wood-only (palette difference); T2+ adds metal
 * banding + emissive rune inlays. HP and crafting cost scale up the chain. Unlock
 * gating uses the existing card tree (alloy_crucible for T2/T3, precious_arc for T4-6).
 */
export type CabinMaterialTier =
  | 'rough_log'
  | 'oak'
  | 'copper_band'
  | 'bronze_band'
  | 'silver_band'
  | 'gold_band'
  | 'platinum_band';

export interface PlacedCabinPiece {
  /** Unique per-session id assigned by `placedCabinPieceCounter`. */
  id: number;
  kind: CabinPieceKind;
  tier: CabinMaterialTier;
  /** World XZ where placed; Y resolved by terrain sampler / vertical stack at place-time. */
  x: number;
  y: number;
  z: number;
  /** Y rotation in radians (R = 90°, mouse wheel = 15° increments during build mode). */
  rotY: number;
  /** Current HP — full at place; future Phase 4 damage system reduces this. */
  hp: number;
  /**
   * Max HP frozen at place time from `cabinPieceMaxHp(kind, tier)`. Persisted (instead
   * of recomputed) so a future tier-balance pass doesn't break existing saves.
   */
  maxHp: number;
  /**
   * Reserved for Phase 3 crystal wraps — null in Phase 1 (field exists now to avoid a
   * future `STATE_VERSION` bump). Phase 3 will widen this to a richer wrap descriptor.
   */
  crystalWrap: null;
}

/* ============================================================================
 * Awakened-mode craft-station placement (Phase 2 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §9)
 *
 * Player crafts a station's materials directly via Build mode in the awakened
 * realm — same UX as cabin pieces. Multi-instance: many campfires / workbenches
 * may coexist on one map. Dream-mode dock-yard slots (the in-prison camp) are
 * unaffected and stay rendered at their fixed XZ.
 * ============================================================================ */

/**
 * Buildable craft-station kinds. `kitchen` is reserved for a future ship; only
 * `campfire`, `workbench`, `forge` are active in the first multi-instance pass.
 * Order matches the dream-mode `CraftStation` union for symmetry; the unused
 * `'hand'` from that union is intentionally omitted (you don't place hands).
 */
export type PlacedCraftStationKind = 'campfire' | 'workbench' | 'forge' | 'kitchen';

export interface PlacedCraftStation {
  /** Unique per-session id assigned by `placedCraftStationCounter`. */
  id: number;
  kind: PlacedCraftStationKind;
  /** World XZ where placed; Y resolved by terrain sampler / floor-top snap at place time. */
  x: number;
  y: number;
  z: number;
  /** Y rotation in radians (R = 90°, mouse wheel = 15° increments during build mode). */
  rotY: number;
  /** Current HP — full at place; future Phase 4 damage system reduces this. */
  hp: number;
  /**
   * Max HP captured at place time (matches the `PlacedCabinPiece` pattern — persisted
   * so future balance passes don't break existing saves).
   */
  maxHp: number;
}

/* ============================================================================
 * Snap point system (Phase 1.5 — see docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md §2.1)
 *
 * Ports GoE's BuildingSystem snap pipeline. Each piece kind defines an array of snap
 * points expressed in piece-local coordinates. The build-mode controller's per-frame
 * pipeline (findSnapXZ + findSnapY) reads these to produce snap candidates.
 * ============================================================================ */

export type SnapDirection = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west';

export interface SnapPoint {
  /** Piece-local offset from group origin (pre-rotation). */
  offset: { x: number; y: number; z: number };
  /** Which face / edge / top this snap point sits on. Drives outward placement vector. */
  direction: SnapDirection;
  /** Other piece kinds that may attach via this snap point. */
  accepts: CabinPieceKind[];
}

/* ============================================================================
 * Awakened-mode mob runtime (Phase 1.5 — see §13)
 *
 * NOT persisted. Resets on reload (matches the existing `activeGather` runtime pattern
 * — wave-based combat doesn't survive reload, by design). Lives on `GameStore` as a
 * private runtime field, exposed via `getActiveAwakenedMobs()`.
 * ============================================================================ */

export type AwakenedMobKind = 'rat' | 'wolf' | 'wanderer';

export interface AwakenedMobInstance {
  /** Per-session id; stable for the mob's lifetime. */
  id: number;
  kind: AwakenedMobKind;
  /** World position; updated each frame by the AI tick. */
  x: number;
  y: number;
  z: number;
  /** Y rotation in radians (mob's body facing). */
  rotY: number;
  /** Current HP. Mob enters `dying` state at <= 0. */
  hp: number;
  /** Max HP captured at spawn. */
  maxHp: number;
  /**
   * AI state machine.
   *   - `idle / chase / attack` : alive states, see `awakenedMobs.ts` for the
   *     transitions.
   *   - `dying`  : HP just hit 0, fall-over + scale-fade animation playing.
   *   - `corpse` : death animation finished but the mob is loot-yielding (rat /
   *     wolf — see `MOB_LOOT` table). Corpse persists for `CORPSE_PERSIST_MS`
   *     so the player can walk over and press E to skin → meat reward. Despawns
   *     when looted OR when the persist timer elapses.
   */
  state: 'idle' | 'chase' | 'attack' | 'dying' | 'corpse';
  /** Real-time ms when current attack cooldown ends (0 = ready). */
  attackReadyMs: number;
  /** Real-time ms when the dying animation completes (transition to corpse OR despawn). */
  diesAtMs: number;
  /**
   * Real-time ms when the corpse times out + auto-despawns (no skin reward).
   * Only meaningful while `state === 'corpse'`. 0 outside the corpse state.
   */
  corpseExpiresAtMs: number;
}

/** One manual gather button (may be disabled until requirements met). */
export interface GatherActionDef {
  id: string;
  title: string;
  detail: string;
  enabled: boolean;
}

export interface GatherActionGroup {
  title: string;
  actions: GatherActionDef[];
}
