/**
 * In-worker awakened mob **store** implementation — mirrors the slice of
 * {@link GameStore} that {@link attachAwakenedMobs} needs, without main-thread
 * `GameStore`. Mutations run on the worker; {@link postAuthoritySnapshot}
 * mirrors roster + id counter to main for HUD / save-adjacent hooks.
 */
import type { AwakenedMobInstance, AwakenedMobKind } from '../core/types';
import { AWAKENED_MOB_STATS } from '../core/gameStore';
import type { MainMessage } from './protocol';

export type WorkerAwakenedMobAuthorityStoreApi = {
  spawnAwakenedMob: (kind: AwakenedMobKind, x: number, y: number, z: number) => AwakenedMobInstance;
  damageAwakenedMob: (id: number, amount: number) => boolean;
  removeAwakenedMob: (id: number) => void;
  getActiveAwakenedMobs: () => ReadonlyArray<AwakenedMobInstance>;
  damagePlayerInAwakened: (amount: number, sourceKind: string) => void;
  getState: () => { pveWave: number };
};

export function createWorkerAwakenedMobAuthorityStore(deps: {
  postMain: (msg: MainMessage) => void;
  getPveWave: () => number;
}): {
  store: WorkerAwakenedMobAuthorityStoreApi;
  postAuthoritySnapshot: () => void;
  clear: () => void;
} {
  const active: AwakenedMobInstance[] = [];
  let mobCounter = 0;

  const store: WorkerAwakenedMobAuthorityStoreApi = {
    spawnAwakenedMob(kind, x, y, z) {
      const stats = AWAKENED_MOB_STATS[kind];
      const id = ++mobCounter;
      const mob: AwakenedMobInstance = {
        id,
        kind,
        x,
        y,
        z,
        rotY: 0,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        state: 'idle',
        attackReadyMs: 0,
        diesAtMs: 0,
        corpseExpiresAtMs: 0,
      };
      active.push(mob);
      return mob;
    },
    damageAwakenedMob(id, amount) {
      const mob = active.find((m) => m.id === id);
      if (!mob || mob.state === 'dying') return false;
      mob.hp = Math.max(0, mob.hp - amount);
      if (mob.hp <= 0) {
        mob.state = 'dying';
        mob.diesAtMs = Date.now() + 1500;
        return true;
      }
      return false;
    },
    removeAwakenedMob(id) {
      const i = active.findIndex((m) => m.id === id);
      if (i >= 0) active.splice(i, 1);
    },
    getActiveAwakenedMobs() {
      return active;
    },
    damagePlayerInAwakened(amount, sourceKind) {
      if (amount <= 0) return;
      deps.postMain({ type: 'awakenedPlayerDamaged', amount, sourceKind });
    },
    getState() {
      return { pveWave: deps.getPveWave() };
    },
  };

  function postAuthoritySnapshot(): void {
    deps.postMain({
      type: 'awakenedMobsAuthoritySnapshot',
      mobs: active.map((m) => ({ ...m })),
      mobCounter,
    });
  }

  function clear(): void {
    active.length = 0;
    mobCounter = 0;
  }

  return { store, postAuthoritySnapshot, clear };
}
