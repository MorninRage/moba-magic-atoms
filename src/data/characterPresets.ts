/**
 * Survivor presets — LPCA differentiation: per-character silhouette + headwear + palette (no glTF).
 * Artisan = bespoke female build + layered hair LPCA (`artisanFemaleLPCA.ts`).
 * Vanguard default = `vanguard_wizard` — procedural robe, hat, staff (`vanguardWizardLPCA.ts`).
 */
import type { CharacterPresetId } from '../core/types';

/** Hat / no hat (bandana removed — artisan uses full hair). */
export type CharacterHeadwear = 'frontier_hat' | 'none';

/** Body + face rig variant (drives mesh visibility and proportional edits). */
export type CharacterBuildKind = 'default' | 'artisan_female' | 'vanguard_wizard';

export interface CharacterPresetPalette {
  skin: number;
  undertunic: number;
  jerkin: number;
  trim: number;
  pants: number;
  boot: number;
  hair: number;
  /** Secondary hair mass (braid / streak) — artisan LPCA. */
  hairStreak?: number;
  /** Forge-wife lip PBR tint. */
  lipRose?: number;
  /** Forge-wife iris (distinct from male dock eyes). */
  eyeIris?: number;
  hatBand: number;
  hatTop: number;
  hatBrim: number;
}

export interface CharacterPresetDef {
  id: CharacterPresetId;
  /** Short UI name */
  name: string;
  /** Archetype line */
  title: string;
  tagline: string;
  palette: CharacterPresetPalette;
  /** Uniform scale on avatar root (whole figure). */
  avatarScale: number;
  /** Torso-only non-uniform scale (stocky / lanky LPCA pass). */
  torsoScale: { x: number; y: number; z: number };
  /** Head group scale (reads distinct at silhouette). */
  headScale: number;
  headwear: CharacterHeadwear;
  /** When `artisan_female`, use layered lathe/tube hair + feminine face deltas. */
  characterBuild?: CharacterBuildKind;
}

export const DEFAULT_CHARACTER_PRESET_ID: CharacterPresetId = 'vanguard';

export const CHARACTER_PRESETS: CharacterPresetDef[] = [
  {
    id: 'vanguard',
    name: 'Vanguard',
    title: 'Arcane warden',
    tagline: 'Tall silhouette, ley-threaded robes, and a staff that answers the road.',
    characterBuild: 'vanguard_wizard',
    /** Slightly taller frame; grounding uses feet, not robe hem, so scale reads as height not float. */
    avatarScale: 1.045,
    torsoScale: { x: 0.99, y: 1.06, z: 0.99 },
    headScale: 1.02,
    headwear: 'none',
    /*
     * DARK FANTASY palette — near-black felt for the hat, deep midnight robe with
     * violet undertones, and richer warm gold for the trim. The local PBR upgrade in
     * `vanguardWizardLPCA.ts` (clearcoat + sheen + emissive gold streaks) leans on
     * these darker base colors to read as polished sorcerer-black rather than flat
     * grey-purple. If you adjust these, also re-check the streak/trim emissive values
     * inside `createVanguardWizardHatLPCA` and `createVanguardWizardRobeLPCA`.
     */
    palette: {
      skin: 0xd4a373,
      undertunic: 0x2a1c4a, // deep amethyst lining
      jerkin: 0x080510, // near-black robe outer
      trim: 0xd4a648, // warmer richer gold
      pants: 0x0c0816,
      boot: 0x161020,
      hair: 0x1a0e08,
      hatBand: 0x2a1c4a,
      hatTop: 0x050308, // deep magical black felt
      hatBrim: 0x040206,
    },
  },
  {
    id: 'artisan',
    name: 'Ember Wright',
    title: 'The forgehand',
    tagline:
      'A female smith of the frontier — soot, brass, and LPCA-forged hair only IDLE-CRAFT wears.',
    avatarScale: 1,
    characterBuild: 'artisan_female',
    /** Narrower shoulders / lighter frame than the male default rig. */
    torsoScale: { x: 0.94, y: 0.97, z: 0.93 },
    headScale: 1.03,
    headwear: 'none',
    palette: {
      skin: 0xd9a088,
      undertunic: 0xc4b0a0,
      jerkin: 0x5c3828,
      trim: 0xd4a03a,
      pants: 0x1c2230,
      boot: 0x352820,
      hair: 0x3d2818,
      hairStreak: 0x6b4428,
      lipRose: 0xc46872,
      eyeIris: 0x3d5230,
      hatBand: 0x4a3518,
      hatTop: 0x5c4224,
      hatBrim: 0x3a2814,
    },
  },
  {
    id: 'wayfarer',
    name: 'Wayfarer',
    title: 'Trail strider',
    tagline: 'Faded dyes and road dust; light on the path, sharp in the wild.',
    avatarScale: 1.02,
    torsoScale: { x: 1, y: 1, z: 1 },
    headScale: 1,
    headwear: 'frontier_hat',
    palette: {
      skin: 0xe0b896,
      undertunic: 0xa8a090,
      jerkin: 0x2a4a42,
      trim: 0x6b8f7a,
      pants: 0x283038,
      boot: 0x243028,
      hair: 0x4a3020,
      hatBand: 0x2a3d36,
      hatTop: 0x355a4c,
      hatBrim: 0x1e3028,
    },
  },
  {
    id: 'geomancer',
    name: 'Geomancer',
    title: 'Ley-touched',
    tagline: 'Cool ley hues threaded through cloth — attuned to dust and ore.',
    avatarScale: 1,
    torsoScale: { x: 1, y: 1, z: 1 },
    headScale: 1,
    headwear: 'frontier_hat',
    palette: {
      skin: 0xcf9a7a,
      undertunic: 0x8a7898,
      jerkin: 0x3a2a58,
      trim: 0x8b7bdc,
      pants: 0x1c1830,
      boot: 0x2a2438,
      hair: 0x1a1428,
      hatBand: 0x3d2a68,
      hatTop: 0x4a3880,
      hatBrim: 0x241848,
    },
  },
  {
    id: 'ridge_runner',
    name: 'Ridge Runner',
    title: 'Highland scout',
    tagline: 'Moss-dyed leathers, long stride — reads weather before it breaks.',
    avatarScale: 1.03,
    torsoScale: { x: 0.96, y: 1.04, z: 0.98 },
    headScale: 0.98,
    headwear: 'frontier_hat',
    palette: {
      skin: 0xc9a080,
      undertunic: 0x8a9a88,
      jerkin: 0x2a4a38,
      trim: 0x6b8c5a,
      pants: 0x1e2820,
      boot: 0x243028,
      hair: 0x2d3828,
      hatBand: 0x3a5040,
      hatTop: 0x4a6048,
      hatBrim: 0x243228,
    },
  },
  {
    id: 'ash_seer',
    name: 'Ash Seer',
    title: 'Ember oracle',
    tagline: 'Soot-streaked robes, bare crown — watches the forge’s last breath.',
    avatarScale: 0.98,
    torsoScale: { x: 1, y: 1, z: 1 },
    headScale: 1.05,
    headwear: 'none',
    palette: {
      skin: 0xe8c4b0,
      undertunic: 0x5a4a58,
      jerkin: 0x3a2a40,
      trim: 0xc87850,
      pants: 0x181820,
      boot: 0x282028,
      hair: 0x4a4038,
      hatBand: 0x3a3038,
      hatTop: 0x483840,
      hatBrim: 0x282028,
    },
  },
  {
    id: 'copper_jack',
    name: 'Copper Jack',
    title: 'Claim jumper',
    tagline: 'Brass rivets, broad shoulders — first through the breach, last off the field.',
    avatarScale: 1,
    torsoScale: { x: 1.06, y: 0.96, z: 1.04 },
    headScale: 0.97,
    headwear: 'frontier_hat',
    palette: {
      skin: 0xd4a080,
      undertunic: 0xa89888,
      jerkin: 0x6a4020,
      trim: 0xd49840,
      pants: 0x282018,
      boot: 0x3a2820,
      hair: 0x3d2818,
      hatBand: 0x8a5020,
      hatTop: 0xa06828,
      hatBrim: 0x5a3818,
    },
  },
  {
    id: 'frost_line',
    name: 'Frost Line',
    title: 'Northern cordon',
    tagline: 'Ice-blue trim, tall silhouette — wind-hardened, glare-proof.',
    avatarScale: 1.01,
    torsoScale: { x: 0.98, y: 1.05, z: 0.97 },
    headScale: 1.04,
    headwear: 'none',
    palette: {
      skin: 0xe0c8c0,
      undertunic: 0x7898b0,
      jerkin: 0x284058,
      trim: 0x98c8e8,
      pants: 0x182028,
      boot: 0x243038,
      hair: 0x283848,
      hatBand: 0x406078,
      hatTop: 0x507888,
      hatBrim: 0x304858,
    },
  },
];

/** Valid preset ids (for migration / server whitelist). */
export const CHARACTER_PRESET_IDS: ReadonlySet<CharacterPresetId> = new Set(
  CHARACTER_PRESETS.map((p) => p.id),
);

const byId = new Map<CharacterPresetId, CharacterPresetDef>(
  CHARACTER_PRESETS.map((p) => [p.id, p]),
);

export function getCharacterPreset(id: CharacterPresetId): CharacterPresetDef {
  return byId.get(id) ?? CHARACTER_PRESETS[0]!;
}
