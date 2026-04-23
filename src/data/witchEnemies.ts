/**
 * Witches Guild enemy definitions — three named witches that drop talisman shards.
 * Encounter order matches `intro_the_shattering` cutscene + `LORE.md` §8 voice trio.
 * Voice metadata is here (not in `EnemyDef`) so future witch dialog wiring can pull it
 * by witch id without polluting the shared enemy type. See
 * `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §6 for the locked design.
 */
import type { EnemyDef, WitchShardId } from '../core/types';

export interface WitchEnemyMeta {
  enemy: EnemyDef;
  /** Maps to `dropShardId` so battle victory grants the correct shard. */
  shardId: WitchShardId;
  /** Piper voice id from `LORE.md` §8 (for future dialog VO baking). */
  voice: string;
}

export const WITCH_ENEMIES: WitchEnemyMeta[] = [
  {
    enemy: {
      id: 'e_witch_cori',
      name: 'Witch of the Eastern Coven',
      maxHp: 60,
      damage: 8,
      isPvP: false,
    },
    shardId: 'cori',
    voice: 'en_GB-cori-medium',
  },
  {
    enemy: {
      id: 'e_witch_jenny',
      name: 'The Iron-Box Witch',
      maxHp: 90,
      damage: 11,
      isPvP: false,
    },
    shardId: 'jenny',
    voice: 'en_GB-jenny_dioco-medium',
  },
  {
    enemy: {
      id: 'e_witch_kristin',
      name: 'The Mocking Witch',
      maxHp: 130,
      damage: 14,
      isPvP: false,
    },
    shardId: 'kristin',
    voice: 'en_US-kristin-medium',
  },
];

/** Lookup by enemy id for the battle victory hook. */
export const WITCH_ENEMY_BY_ID = new Map(WITCH_ENEMIES.map((w) => [w.enemy.id, w]));

/** Lookup by shard id for the start-battle scheduler. */
export const WITCH_ENEMY_BY_SHARD = new Map(WITCH_ENEMIES.map((w) => [w.shardId, w]));

export function isWitchEnemyId(id: string): boolean {
  return WITCH_ENEMY_BY_ID.has(id);
}
