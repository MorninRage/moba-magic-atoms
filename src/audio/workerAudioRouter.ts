/**
 * Worker → main audio router.
 *
 * The render worker can't touch `AudioContext` (Web Audio is main-thread).
 * It posts `{type: 'audioSfx', kind, ...}` messages instead; this module
 * provides the routing function that `WorkerBridge.opts.onAudioSfx`
 * consumers wire to. Each `kind` maps to the matching call in `audioBridge.ts`.
 *
 * Wire-up:
 *   ```
 *   import { routeWorkerAudioSfx } from '../audio/workerAudioRouter';
 *   import type { AudioSfxMessage } from '../worker/protocol';
 *   await CharacterSceneHost.create(container, {
 *     ...,
 *     onAudioSfx: routeWorkerAudioSfx,
 *   });
 *   ```
 */

import type { AudioSfxMessage } from '../worker/protocol';
import {
  playFootstepSound,
  playMagicImpactSound,
  playMobHitSound,
  playMobFootstepSound,
  playMobDeathSound,
  playWaterGatherSound,
  playConsumeSound,
  playMushroomBounceSound,
} from './audioBridge';

/**
 * Route a worker-emitted audio SFX message to the appropriate audioBridge
 * call. Unknown kinds are dropped silently with a console.warn so a
 * protocol-vs-router drift fails noisily during dev but doesn't crash
 * production.
 */
export function routeWorkerAudioSfx(msg: AudioSfxMessage): void {
  switch (msg.kind) {
    case 'footstep':
      /* Footstep alternates between 'L' and 'R' on main; worker doesn't
       * track which is next. The audio bridge has its own footstep
       * alternation state, so we feed a deterministic toggle here. */
      playFootstepSound(footstepToggle.next());
      return;
    case 'magicImpact':
      playMagicImpactSound(msg.intensity ?? 1.0);
      return;
    case 'mobHit':
      playMobHitSound(msg.awakenedMobKind ?? 'rat', msg.intensity ?? 1.0);
      return;
    case 'mobFootstep':
      playMobFootstepSound(msg.awakenedMobKind ?? 'rat', msg.intensity ?? 1.0);
      return;
    case 'mobDeath':
      playMobDeathSound(msg.awakenedMobKind ?? 'rat', msg.intensity ?? 1.0);
      return;
    case 'gatherWater':
      playWaterGatherSound();
      return;
    case 'consume':
      playConsumeSound('meat');
      return;
    case 'mushroomBounce':
      playMushroomBounceSound(msg.intensity ?? 0.8);
      return;
    default: {
      console.warn('[workerAudioRouter] unknown audio kind:', msg);
    }
  }
}

/**
 * Per-document footstep toggle so the L/R alternation reads naturally.
 * Stateful here because main only sees the worker's "footstep" event
 * without left/right info; the worker would need to forward L/R if we
 * wanted exact parity, but a simple toggle works fine for stepping audio
 * (the player can't perceive a 1-step skew during real play).
 */
const footstepToggle = (() => {
  let n = 0;
  return {
    next(): 'L' | 'R' {
      n = (n + 1) & 1;
      return n === 0 ? 'L' : 'R';
    },
  };
})();
