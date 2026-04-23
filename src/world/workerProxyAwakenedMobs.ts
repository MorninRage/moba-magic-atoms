/**
 * Main-thread stub {@link AwakenedMobsHandle} when the render worker owns the
 * awakened mob simulation. Forwards damage + corpse skin to the worker; reads
 * mob roster from {@link GameStore} (mirrored via authority snapshots).
 */
import type { AwakenedMobInstance } from '../core/types';
import type { GameStore } from '../core/gameStore';
import type { WorkerBridge } from '../worker/workerBridge';
import type { AwakenedMobsHandle } from './awakenedMobs';

export function createWorkerProxyAwakenedMobsHandle(deps: {
  store: GameStore;
  bridge: WorkerBridge;
}): AwakenedMobsHandle {
  const { store, bridge } = deps;
  return {
    update() {
      /* Worker ticks mobs; main only mirrors store from snapshots. */
    },
    damage(id, amount, fromXZ, source) {
      void fromXZ;
      const before = store.getActiveAwakenedMobs().find((m) => m.id === id);
      const lethal = !!(before && before.state !== 'dying' && before.hp - amount <= 0);
      bridge.applyAwakenedMobDamageFromMain(id, amount, source);
      return lethal;
    },
    getMob(id) {
      return store.getActiveAwakenedMobs().find((m) => m.id === id) ?? null;
    },
    getAllMobs() {
      return store.getActiveAwakenedMobs();
    },
    getCorpseNearAvatar(avatarXZ, radius) {
      const r = radius ?? 1.8;
      const r2 = r * r;
      let best: AwakenedMobInstance | null = null;
      let bestDist = r;
      for (const mob of store.getActiveAwakenedMobs()) {
        if (mob.state !== 'corpse') continue;
        const dx = mob.x - avatarXZ.x;
        const dz = mob.z - avatarXZ.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2);
        if (d < bestDist) {
          bestDist = d;
          best = mob;
        }
      }
      return best;
    },
    skinCorpse(id) {
      bridge.skinAwakenedCorpseOnWorker(id);
      /* Meat + floaters arrive via `awakenedCorpseSkinLoot` on the authority sink. */
      return null;
    },
    warmShaders() {
      /* Worker warmed on attach. */
    },
    getProximityVolumeScale() {
      return 1;
    },
    clearAll() {
      bridge.clearAwakenedMobsOnWorker();
    },
    dispose() {
      /* Host lifecycle clears worker; no separate dispose. */
    },
  };
}
