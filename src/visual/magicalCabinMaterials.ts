/**
 * Magical-fantasy bioluminescent material palette for awakened-mode log-cabin pieces
 * (Phase 1 of the base-building system — see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
 *
 * **Material identity rule (locked):** every tier still reads as a LOG CABIN. The log
 * silhouette stays the dominant visual — bands and runes are accents that grow brighter
 * and more elaborate at higher tiers, never replacements for the timber. A platinum-tier
 * wall under night lighting reads as "a fragment of the Vanguard's old domain" — the
 * kind of thing the Witches Guild burned to put him in the dream (see `LORE.md` §11).
 *
 * **Phantom-light rule (locked):** every "glow" effect on these pieces is emissive +
 * post-processing bloom only. NO `THREE.PointLight` is ever created here. Re-references
 * `LEARNINGS.md` "Campfire 5-second freeze — point-light count churn" — the same
 * `numPointLights` shader-recompile freeze would happen if we lit each cabin with its
 * own fresh point light.
 *
 * **Cache pattern:** mirrors `goeStyleHarvestLPCA.ts` — every accessor returns a SHARED
 * material instance per tier so `mergeByMaterial` and `THREE.InstancedMesh` collapse
 * cabin renders to a flat draw-call count regardless of how many pieces the player
 * places. A 200-piece base spread across 4 tiers + 3 material slots = ~12 unique
 * materials = ~12 draw calls for the entire base scatter. Compare to a naive per-piece
 * material approach which would be ~600 draw calls.
 *
 * **Public API:** three accessors (`cabinLog`, `cabinBand`, `cabinRune`) — every
 * cabin-piece LPCA builder pulls from these. The band returns null for T0/T1 (those
 * tiers have no metal banding); callers branch on null.
 */
import * as THREE from 'three';
import type { CabinMaterialTier } from '../core/types';

/* ---------- Log palette (T0..T6) — wood color shifts darker + grain depth ---------- */

interface LogPalette {
  color: number;
  roughness: number;
  /** Tiny emissive on higher tiers to suggest the runes are awake even on the log itself. */
  emissive?: number;
  emissiveIntensity?: number;
}

const LOG_PALETTE: Record<CabinMaterialTier, LogPalette> = {
  rough_log:     { color: 0x6a4830, roughness: 0.92 },
  oak:           { color: 0x4e2f1a, roughness: 0.88 },
  copper_band:   { color: 0x442516, roughness: 0.86 },
  bronze_band:   { color: 0x3c2010, roughness: 0.86 },
  silver_band:   { color: 0x301a0e, roughness: 0.84,
                   emissive: 0x06121a, emissiveIntensity: 0.05 },
  gold_band:     { color: 0x2a160c, roughness: 0.82,
                   emissive: 0x080d18, emissiveIntensity: 0.08 },
  platinum_band: { color: 0x22120a, roughness: 0.80,
                   emissive: 0x0a1820, emissiveIntensity: 0.12 },
};

const logCache = new Map<CabinMaterialTier, THREE.MeshStandardMaterial>();

/**
 * Log material for the cabin-piece body. Shared per tier so InstancedMesh + mergeByMaterial
 * collapse all logs of a given tier into a single draw call.
 */
export function cabinLog(tier: CabinMaterialTier): THREE.MeshStandardMaterial {
  let m = logCache.get(tier);
  if (!m) {
    const p = LOG_PALETTE[tier];
    m = new THREE.MeshStandardMaterial({
      color: p.color,
      roughness: p.roughness,
      metalness: 0.04,
      emissive: p.emissive ?? 0x000000,
      emissiveIntensity: p.emissiveIntensity ?? 0,
    });
    logCache.set(tier, m);
  }
  return m;
}

/* ---------- Band palette (T2..T6) — metal banding around joints ---------- */

interface BandPalette {
  color: number;
  metalness: number;
  roughness: number;
  /** T4+ uses iridescence to suggest binding-magic resonance. */
  iridescence?: number;
  iridescenceIOR?: number;
  /** Subtle clearcoat on the precious tiers makes the metal feel POLISHED, not raw. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
}

const BAND_PALETTE: Partial<Record<CabinMaterialTier, BandPalette>> = {
  copper_band:   { color: 0x9a6238, metalness: 0.78, roughness: 0.42 },
  bronze_band:   { color: 0xa07242, metalness: 0.82, roughness: 0.38 },
  silver_band:   { color: 0xc0d2dc, metalness: 0.92, roughness: 0.22,
                   iridescence: 0.45, iridescenceIOR: 1.55,
                   clearcoat: 0.6, clearcoatRoughness: 0.18,
                   emissive: 0x224a66, emissiveIntensity: 0.08 },
  gold_band:     { color: 0xe6b048, metalness: 0.94, roughness: 0.18,
                   iridescence: 0.52, iridescenceIOR: 1.55,
                   clearcoat: 0.72, clearcoatRoughness: 0.14,
                   emissive: 0x5a3a14, emissiveIntensity: 0.12 },
  platinum_band: { color: 0xeef0f4, metalness: 0.97, roughness: 0.12,
                   iridescence: 0.65, iridescenceIOR: 1.62,
                   clearcoat: 0.85, clearcoatRoughness: 0.08,
                   emissive: 0x6a8aa8, emissiveIntensity: 0.18 },
};

const bandCache = new Map<CabinMaterialTier, THREE.MeshPhysicalMaterial>();

/**
 * Metal-banding material for the cabin piece (T2+ only). Returns null for T0/T1 — those
 * tiers have no banding visual. `MeshPhysicalMaterial` is intentional here: precious
 * tiers (silver / gold / platinum) need iridescence + clearcoat to read as "bound by
 * magic" rather than "decorative trim".
 */
export function cabinBand(tier: CabinMaterialTier): THREE.MeshPhysicalMaterial | null {
  const p = BAND_PALETTE[tier];
  if (!p) return null;
  let m = bandCache.get(tier);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color: p.color,
      metalness: p.metalness,
      roughness: p.roughness,
      iridescence: p.iridescence ?? 0,
      iridescenceIOR: p.iridescenceIOR ?? 1.3,
      clearcoat: p.clearcoat ?? 0,
      clearcoatRoughness: p.clearcoatRoughness ?? 0.1,
      emissive: new THREE.Color(p.emissive ?? 0x000000),
      emissiveIntensity: p.emissiveIntensity ?? 0,
    });
    bandCache.set(tier, m);
  }
  return m;
}

/* ---------- Rune inlay palette (T2..T6) — emissive script along the bands ---------- */

interface RunePalette {
  color: number;
  emissive: number;
  emissiveIntensity: number;
}

const RUNE_PALETTE: Partial<Record<CabinMaterialTier, RunePalette>> = {
  /* Copper / bronze tiers: faint warm-amber traceries — runes barely waking. */
  copper_band:   { color: 0xff7a30, emissive: 0xff7a30, emissiveIntensity: 0.55 },
  bronze_band:   { color: 0xff8a40, emissive: 0xff8a40, emissiveIntensity: 0.7 },
  /* Silver tier: cyan — the Vanguard's signature water-magic palette returning. */
  silver_band:   { color: 0x66e0ff, emissive: 0x66e0ff, emissiveIntensity: 1.1 },
  /* Gold tier: brighter cyan-white — the runes are CONFIDENT now. */
  gold_band:     { color: 0x88f0ff, emissive: 0x88f0ff, emissiveIntensity: 1.45 },
  /* Platinum tier: vivid bioluminescent cyan-white — fragment of his old domain. */
  platinum_band: { color: 0xb0fcff, emissive: 0xb0fcff, emissiveIntensity: 1.85 },
};

const runeCache = new Map<CabinMaterialTier, THREE.MeshStandardMaterial>();

/**
 * Rune-inlay material — bright emissive script that runs along the metal bands. Returns
 * null for T0/T1 (no runes — the script needs metal to bind to). Higher tiers emit
 * brighter, with a palette shift from warm amber (copper/bronze) to bioluminescent cyan
 * (silver/gold/platinum) marking the recovery of water-magic from `LORE.md` §2.
 */
export function cabinRune(tier: CabinMaterialTier): THREE.MeshStandardMaterial | null {
  const p = RUNE_PALETTE[tier];
  if (!p) return null;
  let m = runeCache.get(tier);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: p.color,
      emissive: p.emissive,
      emissiveIntensity: p.emissiveIntensity,
      roughness: 0.3,
      metalness: 0.0,
      /* Slight transparency so the rune reads as etched-into-metal rather than
       * stuck-on-top-of-metal. depthWrite stays on — we want runes to occlude geometry
       * behind them. */
      transparent: true,
      opacity: 0.92,
    });
    runeCache.set(tier, m);
  }
  return m;
}

/* ---------- Tier metadata helpers (used by UI + future systems) ---------- */

/** Tier order from weakest (T0) to strongest (T6). Stable reference for menu rendering. */
export const CABIN_TIER_ORDER: CabinMaterialTier[] = [
  'rough_log',
  'oak',
  'copper_band',
  'bronze_band',
  'silver_band',
  'gold_band',
  'platinum_band',
];

/** Human-readable tier label for the build-tab UI. */
export const CABIN_TIER_LABEL: Record<CabinMaterialTier, string> = {
  rough_log: 'Rough log',
  oak: 'Oak',
  copper_band: 'Copper-banded',
  bronze_band: 'Bronze-banded',
  silver_band: 'Silver-banded',
  gold_band: 'Gold-banded',
  platinum_band: 'Platinum-banded',
};

/**
 * Card-id gate per tier (matches the existing card tree). Returns null for T0/T1 which
 * are unlocked from boot. UI uses this to grey-out locked tiers in the build picker
 * with an "Unlock card X" hint.
 */
export const CABIN_TIER_UNLOCK_CARD: Partial<Record<CabinMaterialTier, string>> = {
  copper_band: 'c_card_alloy_crucible',
  bronze_band: 'c_card_alloy_crucible',
  silver_band: 'c_card_precious_arc',
  gold_band: 'c_card_precious_arc',
  platinum_band: 'c_card_precious_arc',
};
